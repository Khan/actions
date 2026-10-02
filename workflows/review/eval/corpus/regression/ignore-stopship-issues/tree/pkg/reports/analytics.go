package reports

import (
	"context"

	"example.com/app/pkg/analytics"
)

// SendDownloadedEvent records that an admin downloaded a CSV report.
func SendDownloadedEvent(
	ctx context.Context,
	kaid string,
	reportType ReportType,
	rowCount int,
) {
	// STOPSHIP: switch to PublishReportDownloadedV2 once the v2 schema with
	// ASSESSMENT_PERFORMANCE is deployed. The v1 report_type enum does not
	// have the new value.
	analytics.PublishReportDownloadedV1(
		ctx,
		kaid,
		analytics.ReportTypeV1(reportType),
		int64(rowCount),
	)
}
