package syncstore

import (
	"encoding/json"
	"errors"
	"regexp"
	"sort"
)

type Payload struct {
	Kind     string   `json:"kind"`
	KeyEpoch int      `json:"keyEpoch"`
	Manifest string   `json:"encryptedManifest"`
	Objects  []string `json:"objects"`
}
type Location struct {
	Revision      string `json:"revision"`
	PathKey       string `json:"pathKey"`
	EncryptedPath string `json:"encryptedPath"`
}
type File struct {
	ID        string   `json:"id"`
	EntryKind string   `json:"entryKind"`
	Location  Location `json:"location"`
	Heads     []string `json:"heads"`
}
type Revision struct {
	ID           string   `json:"id"`
	FileID       string   `json:"fileId"`
	Parents      []string `json:"parents"`
	DeviceID     string   `json:"deviceId"`
	Payload      Payload  `json:"payload"`
	SelectedFrom string   `json:"selectedFrom,omitempty"`
}
type Decision struct {
	Kind      string  `json:"kind"`
	Selected  string  `json:"selectedRevision,omitempty"`
	Source    string  `json:"companionSource,omitempty"`
	Companion *Action `json:"companion,omitempty"`
}
type Action struct {
	Type       string    `json:"type"`
	FileID     string    `json:"fileId"`
	RevisionID string    `json:"revisionId,omitempty"`
	Payload    *Payload  `json:"payload,omitempty"`
	Location   *Location `json:"location,omitempty"`
	Displayed  string    `json:"displayedRevision,omitempty"`
	Expected   string    `json:"expectedLocation,omitempty"`
	Observed   []string  `json:"observedHeads,omitempty"`
	Decision   *Decision `json:"decision,omitempty"`
}
type Commit struct {
	Protocol int      `json:"protocol"`
	VaultID  string   `json:"vaultId"`
	Epoch    string   `json:"epoch"`
	Required []string `json:"requiredFeatures"`
	DeviceID string   `json:"deviceId"`
	OpID     string   `json:"opId"`
	Actions  []Action `json:"actions"`
}
type Receipt struct {
	Epoch string `json:"epoch"`
	Seq   int64  `json:"seq"`
	OpID  string `json:"opId"`
}
type Change struct {
	Seq      int64    `json:"seq"`
	DeviceID string   `json:"deviceId"`
	OpID     string   `json:"opId"`
	Actions  []Action `json:"actions"`
}
type Snapshot struct {
	Epoch      string      `json:"epoch"`
	Boundary   int64       `json:"boundary"`
	Files      []File      `json:"files"`
	Revisions  []Revision  `json:"revisions"`
	Checkpoint *int64      `json:"checkpoint,omitempty"`
	Bases      []BaseProof `json:"bases,omitempty"`
}
type Device struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Token string `json:"token,omitempty"`
}
type Config struct {
	Managed             bool            `json:"-"`
	TrustedProxies      []string        `json:"trustedProxies,omitempty"`
	MetadataMode        string          `json:"metadataMode,omitempty"`
	CleanupMode         string          `json:"cleanupMode,omitempty"`
	DSN                 string          `json:"dsn"`
	Listen              string          `json:"listen"`
	ObjectDir           string          `json:"objectDir"`
	VaultID             string          `json:"vaultId"`
	Epoch               string          `json:"epoch"`
	Devices             []Device        `json:"devices"`
	KeyPackage          json.RawMessage `json:"keyPackage"`
	EnrollmentPublicKey string          `json:"enrollmentPublicKey,omitempty"`
}

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
var blobPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var objectPattern = regexp.MustCompile(`^(c_)?[a-f0-9]{64}$`)

func validID(id string) bool { return idPattern.MatchString(id) }
func code(s string) error    { return errors.New(s) }
func sortedKeys[T any](m map[string]T) []string {
	k := make([]string, 0, len(m))
	for key := range m {
		k = append(k, key)
	}
	sort.Strings(k)
	return k
}
func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	m := map[string]bool{}
	for _, x := range a {
		if m[x] {
			return false
		}
		m[x] = true
	}
	for _, x := range b {
		if !m[x] {
			return false
		}
		delete(m, x)
	}
	return len(m) == 0
}
func sameObjects(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
