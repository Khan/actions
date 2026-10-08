package reports

import (
	"context"
	"fmt"
)

// Export builds the CSV rows for a report and records the download.
func Export(
	ctx context.Context,
	kaid string,
	reportType ReportType,
	store Store,
) ([][]string, error) {
	var rows [][]string
	var err error
	switch reportType {
	case SkillsProgress:
		rows, err = store.SkillsProgressRows(ctx, kaid)
	case MasteryClass:
		rows, err = store.MasteryClassRows(ctx, kaid)
	case KhanmigoUsage:
		rows, err = store.KhanmigoUsageRows(ctx, kaid)
	case AssessmentPerformance:
		rows, err = store.AssessmentPerformanceRows(ctx, kaid)
	default:
		return nil, fmt.Errorf("unsupported report type %q", reportType)
	}
	if err != nil {
		return nil, err
	}

	SendDownloadedEvent(ctx, kaid, reportType, len(rows))
	return rows, nil
}
