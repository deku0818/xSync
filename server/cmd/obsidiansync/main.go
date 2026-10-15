package main

import (
	"context"
	"encoding/json"
	"flag"
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
	flag.Parse()
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
	host, _, e := net.SplitHostPort(c.Listen)
	ip := net.ParseIP(host)
	if e != nil || ip == nil || !ip.IsLoopback() {
		log.Fatal("development server binds to a literal loopback address only; use an SSH tunnel for another computer")
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
		if _, err = admin.Exec(ctx, "CREATE SCHEMA "+*testSchema); err != nil {
			log.Fatal("test namespace creation failed")
		}
		defer func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = admin.Exec(cleanup, "DROP SCHEMA "+*testSchema+" CASCADE")
		}()
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
	log.Print("ObsidianSync development server on ", c.Listen, "; no public listener")
	if e = srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}
