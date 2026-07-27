package resolvers

import (
	"context"

	"github.com/example/webapp/services/quiz/content_client"
)

// resolverEnv is the slice of the request environment the quiz resolvers
// need, kept local so this file names only what it uses.
type resolverEnv interface {
	Content() content_client.ContentService
	Sessions() SessionStore
}

// SessionStore loads the learner's in-progress quiz session.
type SessionStore interface {
	Current(ctx context.Context) (*Session, error)
}

// Session is a learner's position in a managed quiz sequence.
type Session struct {
	// CurrentItemID is the item the learner has not yet answered, or nil
	// when the sequence is complete.
	CurrentItemID *string
	exercises     map[string]string
}

// ExerciseForItem returns the exercise an item belongs to.
func (s *Session) ExerciseForItem(itemID string) (string, bool) {
	exerciseID, ok := s.exercises[itemID]
	return exerciseID, ok
}

type queryResolver struct{}

func loadSession(ctx context.Context, env resolverEnv) (*Session, error) {
	return env.Sessions().Current(ctx)
}
