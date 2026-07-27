package resolvers

import (
	"context"
	"fmt"

	"github.com/example/webapp/services/quiz/content_client"
	"github.com/example/webapp/services/quiz/graphql"
)

// fetchItemJSON looks up the exercise mapping and fetches the quiz item
// JSON complete with answers.
func fetchItemJSON(
	ctx context.Context,
	env resolverEnv,
	session *Session,
	itemID string,
) (string, error) {
	exerciseID, ok := session.ExerciseForItem(itemID)
	if !ok {
		return "", fmt.Errorf("no exercise mapping for item %s", itemID)
	}
	item, err := content_client.GetItemByID(ctx, env, exerciseID, itemID)
	if err != nil {
		return "", err
	}
	return item.Data, nil
}

// GetNextQuizItem returns the item the learner should answer next, or nil
// when the sequence is complete.
func (r *queryResolver) GetNextQuizItem(
	ctx context.Context,
	env resolverEnv,
) (*graphql.SimpleQuizItem, error) {
	session, err := loadSession(ctx, env)
	if err != nil {
		return nil, err
	}
	if session.CurrentItemID == nil {
		return nil, nil
	}
	currentItemID := *session.CurrentItemID

	// Fetch the quiz item
	itemJSON, err := fetchItemJSON(ctx, env, session, currentItemID)
	if err != nil {
		return nil, err
	}

	// Convert to SimpleQuizItem format
	return &graphql.SimpleQuizItem{
		ID:      currentItemID,
		Content: itemJSON,
	}, nil
}
