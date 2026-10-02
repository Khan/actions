package reports

import "context"

// Store reads the rows behind each CSV report.
type Store interface {
	SkillsProgressRows(ctx context.Context, kaid string) ([][]string, error)
	MasteryClassRows(ctx context.Context, kaid string) ([][]string, error)
	KhanmigoUsageRows(ctx context.Context, kaid string) ([][]string, error)
	AssessmentPerformanceRows(ctx context.Context, kaid string) ([][]string, error)
}
