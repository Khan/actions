package notes

import (
	"context"
	"fmt"
	"testing"
)

// eraseFlags is the FlagSet the erasure tests run under.
type eraseFlags struct {
	forced map[string]bool
}

func (f *eraseFlags) Enabled(_ context.Context, name string) bool {
	return f.forced[name]
}

// eraseStore is an in-memory Store for the erasure tests.
type eraseStore struct {
	notes []Note
}

func (s *eraseStore) Run(_ context.Context, q Query) ([]Note, error) {
	limit := q.Limit
	if limit == 0 {
		limit = 1
	}
	var out []Note
	for _, note := range s.notes {
		if note.UserID != q.UserID {
			continue
		}
		if q.KeysOnly {
			note = Note{ID: note.ID}
		}
		out = append(out, note)
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func (s *eraseStore) Delete(_ context.Context, ids []string) error {
	drop := make(map[string]bool, len(ids))
	for _, id := range ids {
		drop[id] = true
	}
	kept := s.notes[:0]
	for _, note := range s.notes {
		if !drop[note.ID] {
			kept = append(kept, note)
		}
	}
	s.notes = kept
	return nil
}

// eraseTestEnv bundles the fakes behind the eraseEnv interface.
type eraseTestEnv struct {
	store *eraseStore
	flags *eraseFlags
}

func (e *eraseTestEnv) Store() Store { return e.store }

func (e *eraseTestEnv) Flags() FlagSet { return e.flags }

// newEraseTestEnv returns the env every erasure test runs under.
// Retention is rolling out everywhere; run the suite with the flag
// on, as production will be.
func newEraseTestEnv() *eraseTestEnv {
	return &eraseTestEnv{
		store: &eraseStore{},
		flags: &eraseFlags{forced: map[string]bool{retentionFlag: true}},
	}
}

func seedNotes(env *eraseTestEnv, n int) {
	for i := 0; i < n; i++ {
		env.store.notes = append(env.store.notes, Note{
			ID:     fmt.Sprintf("note-%d", i),
			UserID: "user-1",
		})
	}
}

func TestEraseUserRemovesAllNotes(t *testing.T) {
	env := newEraseTestEnv()
	// Enough notes to span two deletion pages.
	seedNotes(env, erasePageSize+250)
	if err := EraseUser(context.Background(), env, "user-1"); err != nil {
		t.Fatalf("EraseUser: %v", err)
	}
	if got := len(env.store.notes); got != 0 {
		t.Fatalf("erasure left %d notes, want 0", got)
	}
}

func TestEraseUserNoNotes(t *testing.T) {
	env := newEraseTestEnv()
	if err := EraseUser(context.Background(), env, "user-1"); err != nil {
		t.Fatalf("EraseUser: %v", err)
	}
}
