package main

import "testing"

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
