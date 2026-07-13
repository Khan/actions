// Package datastore wraps the hosted datastore API behind a small
// client that hides the service's per-call operation limits.
package datastore

import (
	"context"
	"fmt"
)

// opBatchSize is the hosted datastore's per-call entity limit. The
// client chunks multi-entity calls to stay under it, so callers may
// pass arbitrarily large slices.
const opBatchSize = 500

// Key names one stored entity.
type Key struct {
	Kind string
	ID   string
}

// KeyQuery selects keys of one kind for one owner.
type KeyQuery struct {
	Kind   string
	Owner  string
	Limit  int
	Cursor string
}

// KeyPage is one page of query results.
type KeyPage struct {
	Keys []Key
	// Cursor resumes the query; empty means no more results.
	Cursor string
}

// rawAPI is the transport seam (the real service or a test fake).
type rawAPI interface {
	ListKeys(ctx context.Context, q KeyQuery) (KeyPage, error)
	DeleteBatch(ctx context.Context, keys []Key) error
}

// Client is the app-facing datastore handle.
type Client struct {
	api rawAPI
}

// ListKeys returns one page of keys matching q.
func (c *Client) ListKeys(ctx context.Context, q KeyQuery) (KeyPage, error) {
	return c.api.ListKeys(ctx, q)
}

// DeleteMulti deletes every key in keys. It chunks the work into
// opBatchSize batches internally, so callers may pass slices of any
// length without tripping the service's per-call entity limit.
func (c *Client) DeleteMulti(ctx context.Context, keys []Key) error {
	for start := 0; start < len(keys); start += opBatchSize {
		end := start + opBatchSize
		if end > len(keys) {
			end = len(keys)
		}
		if err := c.api.DeleteBatch(ctx, keys[start:end]); err != nil {
			return fmt.Errorf("delete batch at %d: %w", start, err)
		}
	}
	return nil
}
