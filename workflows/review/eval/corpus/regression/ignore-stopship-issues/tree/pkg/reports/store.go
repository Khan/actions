package reports

import "context"

// Store reads the rows behind each CSV report.
type Store interface {
	SkillsProgressRows(ctx context.Context, kaid string) ([][]string, error)
	MasteryClassRows(ctx context.Context, kaid string) ([][]string, error)
	KhanmigoUsageRows(ctx context.Context, kaid string) ([][]string, error)
	// TODO(dev-reports): page this once a district's assessment export
	// passes ~10k rows; today's largest is ~2k.
	AssessmentPerformanceRows(ctx context.Context, kaid string) ([][]string, error)
}
