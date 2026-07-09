package notes

import (
	"context"
	"fmt"
)

// maxRetainedNotes is the retention cap: pruning keeps the newest 200
// notes per user and deletes everything older.
const maxRetainedNotes = 200

// PruneUserNotes enforces the retention cap for one user. The
// background retention job calls it for every active user.
func PruneUserNotes(ctx context.Context, env eraseEnv, userID string) error {
	if !env.Flags().Enabled(ctx, retentionFlag) {
		return nil
	}
	notes, err := env.Store().Run(ctx, Query{
		UserID:   userID,
		Limit:    erasePageSize,
		KeysOnly: true,
	})
	if err != nil {
		return fmt.Errorf("list notes to prune for %s: %w", userID, err)
	}
	if len(notes) <= maxRetainedNotes {
		return nil
	}
	ids := make([]string, 0, len(notes)-maxRetainedNotes)
	for _, note := range notes[maxRetainedNotes:] {
		ids = append(ids, note.ID)
	}
	return env.Store().Delete(ctx, ids)
}
