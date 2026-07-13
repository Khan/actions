package notes

import (
	"context"
	"fmt"
	"strings"
)

// digestSize is how many recent notes the digest and sidebar surface.
const digestSize = 5

// digestEnv is the slice of the request environment digests need,
// kept local so this file names only what it uses.
type digestEnv interface {
	Store() Store
}

// BuildDigest renders the user's recent summary notes as one block
// for the home surface, newest first.
func BuildDigest(ctx context.Context, env digestEnv, userID string) (string, error) {
	summaries, err := env.Store().Run(ctx, Query{
		UserID: userID,
		Kind:   "summary",
	})
	if err != nil {
		return "", fmt.Errorf("list summaries for digest of %s: %w", userID, err)
	}
	lines := make([]string, 0, len(summaries))
	for _, note := range summaries {
		lines = append(lines, "- "+note.Body)
	}
	return strings.Join(lines, "\n"), nil
}

// RecentPins lists the user's pinned notes for the sidebar, newest
// first, capped to the sidebar's five slots.
func RecentPins(ctx context.Context, env digestEnv, userID string) ([]Note, error) {
	pins, err := env.Store().Run(ctx, Query{
		UserID: userID,
		Kind:   "pin",
		Limit:  digestSize,
	})
	if err != nil {
		return nil, fmt.Errorf("list pins for %s: %w", userID, err)
	}
	return pins, nil
}
