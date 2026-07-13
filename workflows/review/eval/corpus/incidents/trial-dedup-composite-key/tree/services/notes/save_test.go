package notes

import (
	"context"
	"fmt"
	"testing"
)

// saveStore is an in-memory Store for the save tests.
type saveStore struct {
	notes  []Note
	nextID int
}

func (s *saveStore) Run(_ context.Context, q Query) ([]Note, error) {
	limit := q.Limit
	if limit == 0 {
		limit = 1
	}
	var out []Note
	for _, note := range s.notes {
		if note.UserID != q.UserID {
			continue
		}
		if q.Kind != "" && note.Kind != q.Kind {
			continue
		}
		out = append(out, note)
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func (s *saveStore) Put(_ context.Context, notes []Note) error {
	for _, note := range notes {
		s.nextID++
		note.ID = fmt.Sprintf("note-%d", s.nextID)
		s.notes = append(s.notes, note)
	}
	return nil
}

func (s *saveStore) Delete(_ context.Context, ids []string) error {
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

// saveTestEnv bundles the fakes behind the saveEnv interface.
type saveTestEnv struct {
	store *saveStore
}

func (e *saveTestEnv) Store() Store { return e.store }

func TestSaveSkipsDuplicates(t *testing.T) {
	env := &saveTestEnv{store: &saveStore{}}
	note := Note{
		UserID: "user-1",
		Kind:   "note",
		Body:   "reread chapter three before the quiz",
	}
	if err := SaveNotes(context.Background(), env, "user-1", []Note{note}); err != nil {
		t.Fatalf("SaveNotes: %v", err)
	}
	if err := SaveNotes(context.Background(), env, "user-1", []Note{note}); err != nil {
		t.Fatalf("SaveNotes: %v", err)
	}
	if got := len(env.store.notes); got != 1 {
		t.Fatalf("duplicate save stored %d notes, want 1", got)
	}
}

func TestSaveStoresDistinctNotes(t *testing.T) {
	env := &saveTestEnv{store: &saveStore{}}
	notes := []Note{
		{UserID: "user-1", Kind: "note", Body: "reread chapter three before the quiz"},
		{UserID: "user-1", Kind: "note", Body: "ask about the second practice set"},
	}
	if err := SaveNotes(context.Background(), env, "user-1", notes); err != nil {
		t.Fatalf("SaveNotes: %v", err)
	}
	if got := len(env.store.notes); got != 2 {
		t.Fatalf("stored %d notes, want 2", got)
	}
}
