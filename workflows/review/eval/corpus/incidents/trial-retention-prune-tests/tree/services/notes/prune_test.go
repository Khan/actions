package notes

import (
	"context"
	"fmt"
	"os"
	"testing"
)

// suiteFlags is the FlagSet every prune test runs under.
type suiteFlags struct {
	forced map[string]bool
}

func (f *suiteFlags) Enabled(_ context.Context, name string) bool {
	return f.forced[name]
}

var testFlags = &suiteFlags{forced: map[string]bool{}}

func TestMain(m *testing.M) {
	// Retention is rolling out everywhere; run the whole suite with
	// the flag on, as production will be.
	testFlags.forced[retentionFlag] = true
	os.Exit(m.Run())
}

// pruneStore is an in-memory Store for the prune tests.
type pruneStore struct {
	notes []Note
}

func (s *pruneStore) Run(_ context.Context, q Query) ([]Note, error) {
	limit := q.Limit
	if limit == 0 {
		limit = 1
	}
	var out []Note
	for _, note := range s.notes {
		if note.UserID != q.UserID {
			continue
		}
		out = append(out, note)
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func (s *pruneStore) Delete(_ context.Context, ids []string) error {
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

// pruneTestEnv bundles the fakes behind the pruneEnv interface.
type pruneTestEnv struct {
	store *pruneStore
}

func (e *pruneTestEnv) Store() Store { return e.store }

func (e *pruneTestEnv) Flags() FlagSet { return testFlags }

func seedStore(n int) *pruneStore {
	s := &pruneStore{}
	for i := 0; i < n; i++ {
		s.notes = append(s.notes, Note{
			ID:     fmt.Sprintf("note-%d", i),
			UserID: "user-1",
		})
	}
	return s
}

func TestPruneKeepsRecentNotes(t *testing.T) {
	env := &pruneTestEnv{store: seedStore(5)}
	if err := PruneUserNotes(context.Background(), env, "user-1"); err != nil {
		t.Fatalf("PruneUserNotes: %v", err)
	}
	if got := len(env.store.notes); got != 5 {
		t.Fatalf("prune touched recent notes: kept %d, want 5", got)
	}
}
