// EphemeralRecordEventFilters — request DTO parsed from GraphQL input and
// the persisted base embedded on EphemeralRecordEvent.
package models

import (
	"time"
)

// EphemeralRecordEventFilters doubles as the in-memory request DTO
// (parsed from GraphQL input in mapInputToFilters) and as the persisted
// base embedded on EphemeralRecordEvent.
//
// Fields tagged `datastore:"-"` exist only on the in-memory DTO and are
// not persisted on the EphemeralRecordEvent. They must be dispatched on
// ReportType in reporting.buildConfigFromFilters (and its GraphQL-input
// counterpart, resolvers.mapInputToConfig) to land in their per-type
// Datastore entity (DistrictReportConfig<ReportType>).
//
// New per-report-type parameters should follow this pattern rather
// than adding persisted columns to this struct.
type EphemeralRecordEventFilters struct {
	// The ID of the partnership this request is associated with.
	// May be a District ID or a MetaDistrict ID.
	PartnershipID string `datastore:"partnership_id,omitempty"`

	// The selectedNodeID to filter for. Either a DistrictID or a
	// MetaDistrictID.
	SelectedNodeID string `datastore:"selected_node_id,omitempty"`

	// ChildIDs of the SelectedNodeID. If empty, use all children the user
	// administers (either metadistrictIDs, districtIDs or schoolIDs).
	ChildIDs []string `datastore:"child_ids,noindex"`

	// The students for the matching grades to include in the report.
	// If the grades is empty, it should be all grades in the selected
	// schools.
	Grades []GradeLevel `datastore:"grades,noindex,omitempty"`

	// The teacherKaids that we want to filter the report to only include
	// students in district classes by these teachers.
	// If the teacherKaids is empty, it should not filter by teachers.
	TeacherKaids []string `datastore:"teacher_kaids,noindex"`

	// The district Course SIS values we want to filter the report to
	// only include the students in district classes matching theses
	// courseSIS values.  If courseSISs is empty, it should no filter by
	// courseSIS values.
	CourseSISs []string `datastore:"course_sis,noindex,omitempty"`

	// Deprecated: use `CourseIDs`` instead.
	CourseID string `datastore:"course_id,omitempty,noindex"`

	// The course IDS to filter on.
	CourseIDs []string `datastore:"course_ids,noindex"`

	// True if the report should include Khanmigo usage.
	// Only valid for the OVERALL_DI2 and MAP_DI2 report types.
	IncludeKhanmigoUsage bool `datastore:"include_khanmigo_usage,omitempty"`

	// If true, only include work assigned by the teacher to their
	// district classes.
	// Only valid for the OVERALL_DI2 and MAP_DI2 report types.
	OnlyTeacherCourses bool `datastore:"only_teacher_courses,omitempty"`

	// Fields to group by in the report.
	GroupBy []string `datastore:"group_by,noindex"`

	// If true, group results by course and student rather than just student.
	// This will replace the current GroupBy field.
	CombineByCourse bool `datastore:"combine_by_course,omitempty,noindex"`

	// The rollup level for the report.
	// Empty value means no rollup (default: student level).
	RollupType RollupType `datastore:"rollup_type,omitempty,noindex"`

	DomainID string `datastore:"domain_id,omitempty,noindex"`

	StrandKey string `datastore:"strand_key,omitempty,noindex"`

	Bands []string `datastore:"bands,omitempty,noindex"`

	// Learning Paths test type
	// Only valid for the MAP_DI2 report types.
	TestType LearningPathTestType `datastore:"learning_path_test_type,omitempty"`

	// The ID of the assessment series to include data for. This maps to a set
	// of three individual assessments in the assessments database: one for
	// beginning of year, one for middle, and one for end.
	// Only valid for the ASSESSMENT_PERFORMANCE report type.
	AssessmentSeriesID string `datastore:"assessment_series_id,omitempty"`

	// The ID of the school year (as defined by the assessments database) to
	// include data for.
	// Only valid for the ASSESSMENT_PERFORMANCE report type.
	AssessmentsSchoolYearID string `datastore:"assessments_school_year_id,omitempty"`

	// True if the report is driven by the assessments "staging" database,
	// which contains fake assessments and test data.
	// Only valid for the ASSESSMENT_PERFORMANCE report type.
	UsesAssessmentsStagingDB bool `datastore:"uses_assessments_staging_db,omitempty"`

	ReportType ReportType `datastore:"report_type,noindex"`

	// True if the master reports include units as well as course mastery
	IncludeUnits bool `datastore:"include_units,omitempty,noindex"`

	// The locale field from the context of the user who requested the report
	// used to get the correct skill set from the course.
	KALocale string `datastore:"locale,noindex,omitempty"`

	// the country code from the context of the user who requested the report
	// used to get the correct skill info from the course
	CountryCode string `datastore:"country_code,noindex,omitempty"`

	// The start date the report should cover
	StartDate time.Time `datastore:"start_date,noindex,omitempty"`
	// The end date the report should cover
	EndDate time.Time `datastore:"end_date,noindex,omitempty"`

	// The duration the report should cover
	// the duration is calculated by subtracting the StartDate from EndDate
	Duration time.Duration `datastore:"duration,noindex,omitempty"`
}
