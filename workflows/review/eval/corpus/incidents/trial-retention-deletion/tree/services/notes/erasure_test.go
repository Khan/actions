package notes

import (
	"context"
	"fmt"
	"testing"
)

// fakeStore is an in-memory Store for the erasure tests.
type fakeStore struct {
	notes []Note
}

func (s *fakeStore) Run(_ context.Context, q Query) ([]Note, error) {
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

func (s *fakeStore) Delete(_ context.Context, ids []string) error {
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

// fakeFlags is a FlagSet with every flag forced on.
type fakeFlags struct{}

func (fakeFlags) Enabled(context.Context, string) bool { return true }

// fakeEnv bundles the fakes behind the eraseEnv interface.
type fakeEnv struct {
	store *fakeStore
}

func (e *fakeEnv) Store() Store { return e.store }

func (e *fakeEnv) Flags() FlagSet { return fakeFlags{} }

func seedNotes(n int) *fakeStore {
	s := &fakeStore{}
	for i := 0; i < n; i++ {
		s.notes = append(s.notes, Note{
			ID:     fmt.Sprintf("note-%d", i),
			UserID: "user-1",
		})
	}
	return s
}

func TestEraseUserRemovesStoredNote(t *testing.T) {
	env := &fakeEnv{store: seedNotes(1)}
	if err := EraseUser(context.Background(), env, "user-1"); err != nil {
		t.Fatalf("EraseUser: %v", err)
	}
	if got := len(env.store.notes); got != 0 {
		t.Fatalf("EraseUser left %d notes, want 0", got)
	}
}

func TestDeleteAllForUserPagesToEmpty(t *testing.T) {
	store := seedNotes(7)
	if err := deleteAllForUser(context.Background(), store, "user-1"); err != nil {
		t.Fatalf("deleteAllForUser: %v", err)
	}
	if got := len(store.notes); got != 0 {
		t.Fatalf("deleteAllForUser left %d notes, want 0", got)
	}
}
