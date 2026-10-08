package reports

// ReportType names a CSV report a district admin can export.
type ReportType string

const (
	SkillsProgress        ReportType = "SKILLS_PROGRESS"
	MasteryClass          ReportType = "MASTERY_CLASS"
	KhanmigoUsage         ReportType = "KHANMIGO_USAGE"
	AssessmentPerformance ReportType = "ASSESSMENT_PERFORMANCE"
)
