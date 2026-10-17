package syncstore

import "sort"

type state struct {
	compact   bool
	accepted  map[string]string
	files     map[string]*File
	revisions map[string]Revision
	locations map[string]Location
	objects   map[string]bool
}

func newState() *state {
	return &state{files: map[string]*File{}, revisions: map[string]Revision{}, locations: map[string]Location{}, objects: map[string]bool{}, accepted: map[string]string{}}
}
func (s *state) payload(p *Payload, kind string) error {
	if p == nil || p.KeyEpoch != 1 || p.Manifest == "" || len(p.Manifest) > 2<<20 || p.Objects == nil || len(p.Objects) > 128 || (p.Kind != kind && p.Kind != "deleted") {
		return code("INVALID_REQUEST")
	}
	if p.Kind != "file" && len(p.Objects) > 0 {
		return code("INVALID_REQUEST")
	}
	for _, id := range p.Objects {
		if !objectPattern.MatchString(id) {
			return code("INVALID_REQUEST")
		}
		if !s.objects[id] {
			return code("OBJECT_MISSING")
		}
	}
	return nil
}
func (s *state) location(l *Location) error {
	if l == nil || !validID(l.Revision) || !blobPattern.MatchString(l.PathKey) || l.EncryptedPath == "" || len(l.EncryptedPath) > 16384 {
		return code("INVALID_REQUEST")
	}
	if _, ok := s.locations[l.Revision]; ok {
		return code("LOCATION_STALE")
	}
	s.locations[l.Revision] = *l
	return nil
}
func (s *state) revision(f *File, a Action, parents []string, device, source string) error {
	if !validID(a.RevisionID) {
		return code("INVALID_REQUEST")
	}
	if _, ok := s.revisions[a.RevisionID]; ok {
		return code("REVISION_EXISTS")
	}
	if err := s.payload(a.Payload, f.EntryKind); err != nil {
		return err
	}
	ancestors := map[string]bool{}
	todo := append([]string{}, parents...)
	for len(todo) > 0 {
		p := todo[len(todo)-1]
		todo = todo[:len(todo)-1]
		if ancestors[p] {
			continue
		}
		r, ok := s.revisions[p]
		if (!ok && (!s.compact || s.accepted[p] != f.ID)) || (ok && r.FileID != f.ID) {
			return code("PARENT_MISSING")
		}
		ancestors[p] = true
		if !s.compact {
			todo = append(todo, r.Parents...)
		}
	}
	s.revisions[a.RevisionID] = Revision{a.RevisionID, f.ID, parents, device, *a.Payload, source}
	heads := []string{}
	for _, h := range f.Heads {
		if !ancestors[h] {
			heads = append(heads, h)
		}
	}
	heads = append(heads, a.RevisionID)
	sort.Strings(heads)
	f.Heads = heads
	return nil
}
func (s *state) create(a Action, device string) error {
	if _, ok := s.files[a.FileID]; ok {
		return code("FILE_EXISTS")
	}
	if a.Payload == nil || (a.Payload.Kind != "file" && a.Payload.Kind != "directory") {
		return code("INVALID_REQUEST")
	}
	if err := s.location(a.Location); err != nil {
		return err
	}
	f := &File{a.FileID, a.Payload.Kind, *a.Location, []string{}}
	if err := s.revision(f, a, []string{}, device, ""); err != nil {
		return err
	}
	s.files[f.ID] = f
	return nil
}
func (s *state) apply(c Commit) error {
	touched, moved := map[string]bool{}, map[string]bool{}
	for _, a := range c.Actions {
		if !validID(a.FileID) {
			return code("INVALID_REQUEST")
		}
		set := touched
		if a.Type == "move" {
			set = moved
		}
		if set[a.FileID] {
			return code("INVALID_REQUEST")
		}
		set[a.FileID] = true
		if a.Type == "create" {
			if a.Displayed != "" || a.Expected != "" || a.Decision != nil || a.Observed != nil {
				return code("INVALID_REQUEST")
			}
			if err := s.create(a, c.DeviceID); err != nil {
				return err
			}
			continue
		}
		f, ok := s.files[a.FileID]
		if !ok {
			return code("FILE_MISSING")
		}
		switch a.Type {
		case "branch":
			if a.Payload == nil || a.Payload.Kind != "file" || a.Displayed != "" || a.Location != nil || a.Decision != nil || a.Expected != "" || a.Observed != nil {
				return code("INVALID_REQUEST")
			}
			if err := s.revision(f, a, []string{}, c.DeviceID, ""); err != nil {
				return err
			}
		case "edit":
			if !validID(a.Displayed) || a.Location != nil || a.Decision != nil || a.Expected != "" || a.Observed != nil {
				return code("INVALID_REQUEST")
			}
			if err := s.revision(f, a, []string{a.Displayed}, c.DeviceID, ""); err != nil {
				return err
			}
		case "move":
			if a.Payload != nil || a.Decision != nil || a.RevisionID != "" || a.Displayed != "" || a.Observed != nil {
				return code("INVALID_REQUEST")
			}
			if a.Expected != f.Location.Revision {
				return code("LOCATION_STALE")
			}
			if err := s.location(a.Location); err != nil {
				return err
			}
			f.Location = *a.Location
		case "resolve":
			if a.Location != nil || a.Displayed != "" || (a.Expected != "" && a.Expected != f.Location.Revision) || a.Decision == nil || len(f.Heads) < 2 || !sameSet(f.Heads, a.Observed) {
				return code("REVIEW_STALE")
			}
			d := a.Decision
			source := ""
			if d.Kind != "manual" {
				selected, ok := s.revisions[d.Selected]
				if !ok || !contains(a.Observed, d.Selected) || a.Payload == nil || selected.Payload.Kind != a.Payload.Kind || selected.Payload.KeyEpoch != a.Payload.KeyEpoch || !sameObjects(selected.Payload.Objects, a.Payload.Objects) {
					return code("INVALID_REQUEST")
				}
				source = d.Selected
				if d.Kind == "keep-both" {
					other, ok := s.revisions[d.Source]
					if !ok || len(a.Observed) != 2 || d.Source == d.Selected || !contains(a.Observed, d.Source) || d.Companion == nil || d.Companion.Type != "create" || !validID(d.Companion.FileID) || touched[d.Companion.FileID] || d.Companion.Payload == nil || other.Payload.Kind == "deleted" || other.Payload.Kind != d.Companion.Payload.Kind || other.Payload.KeyEpoch != d.Companion.Payload.KeyEpoch || !sameObjects(other.Payload.Objects, d.Companion.Payload.Objects) {
						return code("INVALID_REQUEST")
					}
					if d.Companion.Displayed != "" || d.Companion.Expected != "" || d.Companion.Decision != nil || d.Companion.Observed != nil {
						return code("INVALID_REQUEST")
					}
					touched[d.Companion.FileID] = true
					if err := s.create(*d.Companion, c.DeviceID); err != nil {
						return err
					}
					r := s.revisions[d.Companion.RevisionID]
					r.SelectedFrom = d.Source
					s.revisions[r.ID] = r
				} else if d.Kind != "select" || d.Companion != nil || d.Source != "" {
					return code("INVALID_REQUEST")
				}
			} else if d.Selected != "" || d.Source != "" || d.Companion != nil {
				return code("INVALID_REQUEST")
			}
			if err := s.revision(f, a, append([]string{}, a.Observed...), c.DeviceID, source); err != nil {
				return err
			}
		default:
			return code("INVALID_REQUEST")
		}
	}
	paths := map[string]bool{}
	for _, f := range s.files {
		if paths[f.Location.PathKey] {
			return code("PATH_OCCUPIED")
		}
		paths[f.Location.PathKey] = true
	}
	return nil
}
func contains(a []string, x string) bool {
	for _, y := range a {
		if x == y {
			return true
		}
	}
	return false
}
