// Package content_client fetches quiz items from the content service.
package content_client

import "context"

// Item is a quiz item as the content service stores it.
type Item struct {
	ID string
	// Data is the item JSON complete with answers: the correct response,
	// the scoring rubric, and the hint chain.
	Data string
	// DataAnswerless is the same JSON with those stripped -- the only form
	// safe to send to a learner.
	DataAnswerless string
}

// ContentService is the slice of the content service this package calls.
type ContentService interface {
	Item(ctx context.Context, exerciseID, itemID string) (Item, error)
}

// contentEnv is the slice of the request environment this client needs,
// kept local so this file names only what it uses.
type contentEnv interface {
	Content() ContentService
}

// GetItemByID fetches the item JSON complete with answers, for scoring.
func GetItemByID(
	ctx context.Context,
	env contentEnv,
	exerciseID string,
	itemID string,
) (Item, error) {
	return env.Content().Item(ctx, exerciseID, itemID)
}
