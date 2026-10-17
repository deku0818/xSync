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
	cleanupOnce := flag.Bool("cleanup-once", false, "run one local maintenance pass; no HTTP listener")
	cleanupDryRun := flag.Bool("cleanup-dry-run", false, "only report ciphertext candidates with --cleanup-once")
	testFault := flag.String("test-maintenance-fault", "", "SIGKILL at an isolated test maintenance boundary")
	file := flag.String("config", "", "server config JSON path")
	enrollFor := flag.Duration("enroll-for", 0, "open device enrollment for up to 1h; 0 closes it; local admin command")
	revoke := flag.String("revoke-device", "", "revoke a device ID; local admin command")
	listDevices := flag.Bool("list-devices", false, "list device IDs, names and revocation state; local admin command")
	tlsCert := flag.String("tls-cert", "", "TLS certificate file (required for non-loopback listeners)")
	tlsKey := flag.String("tls-key", "", "TLS private key file")
	testSchema := flag.String("test-schema", "", "isolated e2e test namespace (development only)")
	resumeTestSchema := flag.Bool("resume-test-schema", false, "resume and retain an existing isolated test namespace for interactive device tests")
	developmentLAN := flag.Bool("dev-lan-listen", false, "allow a literal private IP only with an isolated --test-schema; synthetic tests only")
	flag.Parse()
	enrollmentCommand := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "enroll-for" {
			enrollmentCommand = true
		}
	})
	if *cleanupDryRun && !*cleanupOnce {
		log.Fatal("--cleanup-dry-run requires --cleanup-once")
	}
	if *testFault != "" && (!*cleanupOnce || *testSchema == "" || !*resumeTestSchema) {
		log.Fatal("maintenance faults require a resumed isolated test namespace")
	}
	if enrollmentCommand && (*enrollFor < 0 || *enrollFor > time.Hour) {
		log.Fatal("--enroll-for must be between 0 and 1h")
	}
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
	if dsn := os.Getenv("XSYNC_DATABASE_URL"); dsn != "" {
		c.DSN = dsn
	}
	if c.DSN == "" {
		log.Fatal("database URL required in XSYNC_DATABASE_URL or config")
	}
	if (*tlsCert == "") != (*tlsKey == "") {
		log.Fatal("--tls-cert and --tls-key must be supplied together")
	}
	commands := 0
	if *cleanupOnce {
		commands++
	}
	if enrollmentCommand {
		commands++
	}
	if *revoke != "" {
		commands++
	}
	if *listDevices {
		commands++
	}
	if commands > 1 {
		log.Fatal("use one admin command at a time")
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8873"
	}
	if commands == 0 {
		e = validateServerListen(c.Listen, *testSchema, *developmentLAN, *tlsCert != "")
	}
	if e != nil {
		log.Fatal(e)
	}
	c.ObjectDir, e = filepath.Abs(c.ObjectDir)
	if e != nil {
		log.Fatal(e)
	}
	if commands == 0 {
		e = os.MkdirAll(c.ObjectDir, 0700)
	}
	if e != nil {
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
	if *listDevices {
		rows, err := s.Devices(ctx)
		if err != nil {
			log.Fatal("device listing failed")
		}
		result := []map[string]any{}
		for _, row := range rows {
			result = append(result, map[string]any{"id": row.ID, "name": row.Name, "revoked": row.Revoked})
		}
		if e = json.NewEncoder(os.Stdout).Encode(result); e != nil {
			log.Fatal("device output failed")
		}
		return
	}
	if enrollmentCommand {
		if e = s.OpenEnrollment(ctx, *enrollFor); e != nil {
			log.Fatal("enrollment window update failed: ", e)
		}
		log.Print("device enrollment window updated")
		return
	}
	if *revoke != "" {
		if e = s.RevokeDevice(ctx, *revoke); e != nil {
			log.Fatal("device revocation failed: ", e)
		}
		log.Print("device revoked")
		return
	}
	if *cleanupOnce {
		if e = s.AuditHeads(ctx); e != nil {
			log.Fatal("content maintenance refused: current object audit failed")
		}
		if *testFault != "" {
			s.Fault = func(point string) error {
				if point == *testFault {
					_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
				}
				return nil
			}
		}
		policy := syncstore.DefaultCleanupPolicy()
		policy.DryRun = *cleanupDryRun || c.CleanupMode == "dry-run"
		report, err := s.Collect(ctx, policy)
		if err != nil {
			if err.Error() == "SNAPSHOT_TOO_LARGE" {
				log.Fatal("content maintenance refused: SNAPSHOT_TOO_LARGE; original log retained")
			}
			log.Fatal("content maintenance incomplete")
		}
		if e = json.NewEncoder(os.Stdout).Encode(report); e != nil {
			log.Fatal("maintenance output failed")
		}
		return
	}
	// Administrative invocations above never start maintenance. Shutdown waits for the worker before closing PG.
	maintenanceDone := make(chan struct{})
	go func() {
		defer close(maintenanceDone)
		if c.CleanupMode == "off" {
			return
		}
		if err := s.AuditHeads(ctx); err != nil {
			log.Print("content maintenance disabled: current object audit failed")
			return
		}
		policy := syncstore.DefaultCleanupPolicy()
		policy.DryRun = c.CleanupMode == "dry-run"
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			if ctx.Err() != nil {
				return
			}
			if report, err := s.Collect(ctx, policy); err != nil {
				if ctx.Err() == nil {
					if err.Error() == "SNAPSHOT_TOO_LARGE" {
						log.Print("content maintenance refused: SNAPSHOT_TOO_LARGE; original log retained")
					} else {
						log.Print("content maintenance incomplete; will retry")
					}
				}
			} else if report.Deleted+report.Orphans > 0 || report.Changes+report.Snapshots+report.Revisions+report.Locations > 0 || policy.DryRun || report.LogDeferred {
				log.Printf("sync maintenance: candidates=%d deleted=%d logs=%d snapshots=%d revisions=%d locations=%d orphans=%d dryRun=%t logDeferred=%t", report.Candidates, report.Deleted, report.Changes, report.Snapshots, report.Revisions, report.Locations, report.Orphans, policy.DryRun, report.LogDeferred)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	defer func() { stop(); <-maintenanceDone }()
	srv := &http.Server{Addr: c.Listen, Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		<-ctx.Done()
		s.CloseEvents()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Print("xSync server on ", c.Listen)
	if *tlsCert != "" {
		e = srv.ListenAndServeTLS(*tlsCert, *tlsKey)
	} else {
		e = srv.ListenAndServe()
	}
	if e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}

func validateServerListen(listen, testSchema string, developmentLAN, tls bool) error {
	if tls && testSchema == "" && !developmentLAN {
		host, port, e := net.SplitHostPort(listen)
		if e == nil && net.ParseIP(host) != nil && port != "" {
			return nil
		}
		return fmt.Errorf("TLS listener requires a literal IP and port")
	}
	return validateListen(listen, testSchema, developmentLAN)
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
