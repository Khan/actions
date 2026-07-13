package notes

import (
	"context"
	"fmt"

	"example.dev/notesvc/internal/datastore"
)

// purgePageSize is how many keys each listing page fetches.
const purgePageSize = 1000

// PurgeUserNotes hard-deletes every note entity a user has stored.
// The account-erasure pipeline calls it after the retention window
// closes; nothing the user wrote may survive it.
//
// Keys are collected up front and deleted in one call: re-listing
// between deletes raced the store's eventually-consistent index and
// made the loop spin on already-deleted keys.
func PurgeUserNotes(ctx context.Context, client *datastore.Client, userID string) error {
	var keys []datastore.Key
	cursor := ""
	for {
		page, err := client.ListKeys(ctx, datastore.KeyQuery{
			Kind:   "Note",
			Owner:  userID,
			Limit:  purgePageSize,
			Cursor: cursor,
		})
		if err != nil {
			return fmt.Errorf("list note keys for %s: %w", userID, err)
		}
		keys = append(keys, page.Keys...)
		if page.Cursor == "" {
			break
		}
		cursor = page.Cursor
	}
	if len(keys) == 0 {
		return nil
	}
	// A heavy note-taker can hold tens of thousands of notes; delete
	// them all in one DeleteMulti call.
	return client.DeleteMulti(ctx, keys)
}
