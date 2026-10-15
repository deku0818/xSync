package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"log"
	"net"
	"net/http"
	"obsidiansync/server/internal/syncstore"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"syscall"
	"time"
)

func main() {
	file := flag.String("config", "", "development config JSON path")
	testSchema := flag.String("test-schema", "", "isolated e2e test namespace (development only)")
	resumeTestSchema := flag.Bool("resume-test-schema", false, "resume and retain an existing isolated test namespace for interactive device tests")
	developmentLAN := flag.Bool("dev-lan-listen", false, "allow a literal private IP only with an isolated --test-schema; synthetic tests only")
	flag.Parse()
	if *resumeTestSchema && *testSchema == "" {
		log.Fatal("--resume-test-schema requires --test-schema")
	}
	if *file == "" {
		log.Fatal("--config is required")
	}
	b, e := os.ReadFile(*file)
	if e != nil {
		log.Fatal("cannot read config")
	}
	var c syncstore.Config
	if e = json.Unmarshal(b, &c); e != nil {
		log.Fatal("invalid config")
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8873"
	}
	if e = validateListen(c.Listen, *testSchema, *developmentLAN); e != nil {
		log.Fatal(e)
	}
	c.ObjectDir, e = filepath.Abs(c.ObjectDir)
	if e != nil {
		log.Fatal(e)
	}
	if e = os.MkdirAll(c.ObjectDir, 0700); e != nil {
		log.Fatal(e)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *testSchema != "" {
		if !regexp.MustCompile(`^e2e_[a-f0-9]{16}$`).MatchString(*testSchema) {
			log.Fatal("invalid e2e namespace")
		}
		admin, err := pgxpool.New(ctx, c.DSN)
		if err != nil {
			log.Fatal("test DB connection failed")
		}
		defer admin.Close()
		if *resumeTestSchema {
			var exists bool
			if err = admin.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)", *testSchema).Scan(&exists); err != nil || !exists {
				log.Fatal("isolated namespace to resume does not exist")
			}
		} else {
			if _, err = admin.Exec(ctx, "CREATE SCHEMA "+*testSchema); err != nil {
				log.Fatal("test namespace creation failed")
			}
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_, _ = admin.Exec(cleanup, "DROP SCHEMA "+*testSchema+" CASCADE")
			}()
		}
		c.DSN += "&search_path=" + *testSchema
	}
	s, e := syncstore.Open(ctx, c)
	if e != nil {
		log.Fatal("store startup failed: ", e)
	}
	defer s.Pool.Close()
	srv := &http.Server{Addr: c.Listen, Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		<-ctx.Done()
		s.CloseEvents()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Print("ObsidianSync development server on ", c.Listen, "; public listeners disabled")
	if e = srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}

func validateListen(listen, testSchema string, developmentLAN bool) error {
	host, _, err := net.SplitHostPort(listen)
	ip := net.ParseIP(host)
	if err == nil && ip != nil {
		if ip.IsLoopback() {
			return nil
		}
		if developmentLAN && ip.IsPrivate() && regexp.MustCompile(`^e2e_[a-f0-9]{16}$`).MatchString(testSchema) {
			return nil
		}
	}
	return fmt.Errorf("development server requires a literal loopback IP; private LAN requires --dev-lan-listen and an isolated --test-schema")
}
