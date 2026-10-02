package models

import (
	"maps"
	"reflect"
	"testing"

	"github.com/Khan/webapp/dev/servicetest"
)

// fieldSpec pins one struct field: its Go type and its datastore tag value.
// Comparing both catches a field that changes type or whose datastore tag
// drifts, not just renames.
type fieldSpec struct {
	typ string
	tag string
}

// directFields returns the directly-declared fields of a struct type keyed by
// name.
func directFields(t reflect.Type) map[string]fieldSpec {
	out := make(map[string]fieldSpec, t.NumField())
	for f := range t.Fields() {
		out[f.Name] = fieldSpec{
			typ: f.Type.String(),
			tag: f.Tag.Get("datastore"),
		}
	}
	return out
}

type districtReportConfigSuite struct{ servicetest.Suite }

// TestDistrictReportConfigFields pins the field set of every concrete
// DistrictReportConfig type: each field's name, Go type, and datastore tag.
// Pinning the whole set means any change must be deliberate.
func (suite *districtReportConfigSuite) TestDistrictReportConfigFields() {
	embeds := map[string]fieldSpec{
		"BaseModel":                {"datastore.BaseModel", ""},
		"DistrictReportConfigBase": {"models.DistrictReportConfigBase", ""},
	}
	cases := map[string]struct {
		config DistrictReportConfig
		own    map[string]fieldSpec
	}{
		"overall": {
			config: &DistrictReportConfigOverall{},
			own: map[string]fieldSpec{
				"Grades":               {"[]models.GradeLevel", "grades,noindex"},
				"GroupBy":              {"[]string", "group_by,noindex"},
				"CombineByCourse":      {"bool", "combine_by_course,omitempty,noindex"},
				"IncludeKhanmigoUsage": {"bool", "include_khanmigo_usage,omitempty"},
				"CourseIDs":            {"[]string", "course_ids,noindex"},
				"OnlyTeacherCourses":   {"bool", "only_teacher_courses,omitempty"},
				"DomainID":             {"string", "domain_id,omitempty,noindex"},
			},
		},
		"learning_paths_overall": {
			config: &DistrictReportConfigLearningPathsOverall{},
			own: map[string]fieldSpec{
				"Grades":               {"[]models.GradeLevel", "grades,noindex"},
				"GroupBy":              {"[]string", "group_by,noindex"},
				"IncludeKhanmigoUsage": {"bool", "include_khanmigo_usage,omitempty"},
				"OnlyTeacherCourses":   {"bool", "only_teacher_courses,omitempty"},
				"TestType": {
					"models.LearningPathTestType",
					"learning_path_test_type,omitempty",
				},
			},
		},
		"khanmigo": {
			config: &DistrictReportConfigKhanmigo{},
			own: map[string]fieldSpec{
				"Grades":             {"[]models.GradeLevel", "grades,noindex"},
				"GroupBy":            {"[]string", "group_by,noindex"},
				"CombineByCourse":    {"bool", "combine_by_course,omitempty,noindex"},
				"CourseIDs":          {"[]string", "course_ids,noindex"},
				"OnlyTeacherCourses": {"bool", "only_teacher_courses,omitempty"},
				"DomainID":           {"string", "domain_id,omitempty,noindex"},
			},
		},
		"kad_skills": {
			config: &DistrictReportConfigKADSkills{},
			own: map[string]fieldSpec{
				"CourseSISs":   {"[]string", "course_sis,noindex"},
				"Grades":       {"[]models.GradeLevel", "grades,noindex"},
				"CourseIDs":    {"[]string", "course_ids,noindex"},
				"TeacherKaids": {"[]string", "teacher_kaids,noindex"},
			},
		},
		"learning_paths_skills": {
			config: &DistrictReportConfigLearningPathsSkills{},
			own: map[string]fieldSpec{
				"Grades":       {"[]models.GradeLevel", "grades,noindex"},
				"StrandKey":    {"string", "strand_key,omitempty,noindex"},
				"Bands":        {"[]string", "bands,noindex"},
				"TeacherKaids": {"[]string", "teacher_kaids,noindex"},
				"TestType": {
					"models.LearningPathTestType",
					"learning_path_test_type,omitempty",
				},
			},
		},
		"mastery": {
			config: &DistrictReportConfigMastery{},
			own: map[string]fieldSpec{
				"CourseSISs":   {"[]string", "course_sis,noindex"},
				"Grades":       {"[]models.GradeLevel", "grades,noindex"},
				"TeacherKaids": {"[]string", "teacher_kaids,noindex"},
				"IncludeUnits": {"bool", "include_units,omitempty,noindex"},
			},
		},
		"course_challenge": {
			config: &DistrictReportConfigCourseChallenge{},
			own: map[string]fieldSpec{
				"CourseSISs":   {"[]string", "course_sis,noindex"},
				"Grades":       {"[]models.GradeLevel", "grades,noindex"},
				"CourseIDs":    {"[]string", "course_ids,noindex"},
				"TeacherKaids": {"[]string", "teacher_kaids,noindex"},
			},
		},
		"assessment_performance": {
			config: &DistrictReportConfigAssessmentPerformance{},
			own: map[string]fieldSpec{
				"Grades":             {"[]models.GradeLevel", "grades,noindex"},
				"AssessmentSeriesID": {"string", "assessment_series_id,noindex"},
				"SchoolYearID":       {"string", "school_year_id,noindex"},
				"UsesStagingDB":      {"bool", "uses_staging_db,noindex"},
			},
		},
	}
	for name, tc := range cases {
		suite.Run(name, func() {
			want := map[string]fieldSpec{}
			maps.Copy(want, embeds)
			maps.Copy(want, tc.own)
			got := directFields(reflect.TypeOf(tc.config).Elem())
			suite.Require().Equal(want, got)
		})
	}
}

// TestDistrictReportConfigBaseFields pins the fields shared by every config
// type through the embedded DistrictReportConfigBase.
func (suite *districtReportConfigSuite) TestDistrictReportConfigBaseFields() {
	want := map[string]fieldSpec{
		"ExpiresAt":      {"time.Time", "expires_at,omitempty,noindex"},
		"CreatedAt":      {"time.Time", "created_at,omitempty"},
		"SelectedNodeID": {"string", "selected_node_id,omitempty"},
		"ChildIDs":       {"[]string", "child_ids,noindex"},
		"ReportType":     {"models.ReportType", "report_type,noindex"},
		"KALocale":       {"string", "locale,noindex,omitempty"},
		"CountryCode":    {"string", "country_code,noindex,omitempty"},
		"StartDate":      {"time.Time", "start_date,noindex,omitempty"},
		"EndDate":        {"time.Time", "end_date,noindex,omitempty"},
		"Duration":       {"time.Duration", "duration,noindex,omitempty"},
		"RollupType":     {"models.RollupType", "rollup_type,omitempty,noindex"},
	}
	got := directFields(reflect.TypeFor[DistrictReportConfigBase]())
	suite.Require().Equal(want, got)
}

func TestDistrictReportConfig(t *testing.T) {
	servicetest.Run(t, new(districtReportConfigSuite))
}
