// Package langtool wraps the language-tooling service API.
package langtool

import "context"

// Client calls the language-tooling service; ctx is stored at construction.
type Client struct {
	ctx  context.Context
	http httpDoer
}

// ListTraces returns the traces recorded for a project.
func (c *Client) ListTraces(projectID string) ([]Trace, error) {
	req, err := c.newRequest(c.ctx, "GET", "/api/v2/traces?projectId="+projectID)
	if err != nil {
		return nil, err
	}
	return traces, nil
}

// ListObservations fetches every observation for a trace, following the
// cursor until the API reports no next page.
func (c *Client) ListObservations(ctx context.Context, traceID string) ([]Observation, error) {
	req, err := c.newRequest(ctx, "GET", "/api/v2/observations?traceId="+traceID)
	if err != nil {
		return nil, err
	}
	return decodeObservations(c.http.Do(req))
}

// ListScores returns the scores recorded for a trace.
func (c *Client) ListScores(traceID string) ([]Score, error) {
	req, err := c.newRequest(c.ctx, "GET", "/api/v2/scores?traceId="+traceID)
	if err != nil {
		return nil, err
	}
	return decodeScores(c.http.Do(req))
}
