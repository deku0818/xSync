package main

import "testing"

func TestProductionTLSBoundary(t *testing.T) {
	for _, test := range []struct {
		address      string
		tls, allowed bool
	}{
		{"0.0.0.0:8873", false, false}, {"0.0.0.0:8873", true, true}, {"[::]:8873", true, true}, {"192.168.1.10:8873", false, false}, {"localhost:8873", true, false}, {"127.0.0.1:8873", false, true},
	} {
		if got := validateServerListen(test.address, "", false, test.tls) == nil; got != test.allowed {
			t.Errorf("%+v: allowed=%v", test, got)
		}
	}
}

func TestDevelopmentListenBoundary(t *testing.T) {
	for _, test := range []struct {
		address string
		schema  string
		lan     bool
		allowed bool
	}{
		{"127.0.0.1:8873", "", false, true},
		{"[::1]:8873", "", false, true},
		{"172.16.100.160:8874", "", false, false},
		{"172.16.100.160:8874", "e2e_1234567890abcdef", false, false},
		{"172.16.100.160:8874", "", true, false},
		{"172.16.100.160:8874", "other-schema", true, false},
		{"172.16.100.160:8874", "e2e_1234567890abcdef", true, true},
		{"0.0.0.0:8874", "e2e_1234567890abcdef", true, false},
		{"8.8.8.8:8874", "e2e_1234567890abcdef", true, false},
		{"localhost:8874", "e2e_1234567890abcdef", true, false},
	} {
		if allowed := validateListen(test.address, test.schema, test.lan) == nil; allowed != test.allowed {
			t.Errorf("%s schema=%q lan=%v: allowed=%v, want=%v", test.address, test.schema, test.lan, allowed, test.allowed)
		}
	}
}
