package resolvers

import (
	"slices"
	"testing"
	"time"

	"github.com/Khan/webapp/dev/khantest"
	"github.com/Khan/webapp/dev/servicetest"
	"github.com/Khan/webapp/pkg/lib/generic"
	"github.com/Khan/webapp/services/districts/generated/graphql"
	"github.com/Khan/webapp/services/districts/models"
	"github.com/Khan/webapp/services/districts/rostering"
)

type csvExportSuite struct{ servicetest.Suite }

// --- rollupTypeFromGraphQL ---

func (suite *csvExportSuite) TestRollupTypeFromGraphQL() {
	classroom := graphql.AdminRollupTypeClassroom
	teacher := graphql.AdminRollupTypeTeacher
	grade := graphql.AdminRollupTypeGrade
	school := graphql.AdminRollupTypeSchool

	tests := []struct {
		name string
		rt   *graphql.AdminRollupType
		want models.RollupType
	}{
		{"nil returns empty", nil, ""},
		{"CLASSROOM", &classroom, models.ClassroomRollup},
		{"TEACHER", &teacher, models.TeacherRollup},
		{"GRADE", &grade, models.GradeRollup},
		{"SCHOOL", &school, models.SchoolRollup},
	}
	for _, tt := range tests {
		suite.Run(tt.name, func() {
			got := rollupTypeFromGraphQL(tt.rt)
			suite.Require().Equal(tt.want, got)
		})
	}
}

// --- validateCSVExportInput ---

func (suite *csvExportSuite) TestValidateCSVExportInput() {
	oat := rostering.OperationsAndAlgebraicThinking

	tests := []struct {
		name    string
		input   graphql.RequestCSVExportInput
		wantErr bool
	}{
		{
			name: "OVERALL_DI2 no special requirements",
			input: graphql.RequestCSVExportInput{
				ReportType: graphql.AdminReportTypeOverallDi2,
				Settings:   &graphql.CSVReportSettings{},
			},
		},
		{
			name: "MAP_DI2 no special requirements",
			input: graphql.RequestCSVExportInput{
				ReportType: graphql.AdminReportTypeMapDi2,
				Settings:   &graphql.CSVReportSettings{},
			},
		},
		{
			name: "KAD_SKILLS missing courseIDs",
			input: graphql.RequestCSVExportInput{
				ReportType: graphql.AdminReportTypeKadSkillsProgress,
				Settings:   &graphql.CSVReportSettings{},
			},
			wantErr: true,
		},
		{
			name: "KAD_SKILLS with courseIDs",
			input: graphql.RequestCSVExportInput{
				ReportType: graphql.AdminReportTypeKadSkillsProgress,
				Settings: &graphql.CSVReportSettings{
					CourseIDs: []string{"course1"},
				},
			},
		},
		{
			name: "MAP_SKILLS strand with no bands",
			input: graphql.RequestCSVExportInput{
				ReportType: graphql.AdminReportTypeMapSkillsProgress,
				Settings: &graphql.CSVReportSettings{
					StrandKey: &oat,
					Bands:     []string{},
				},
			},
			wantErr: true,
		},
		// Dynamic band/strand ID validation (against the district's test
		// catalog) requires a datastore context and is covered by
		// integration tests in report_test.go.
		{
			name: "MAP_SKILLS all strands (nil strandKey)",
			input: graphql.RequestCSVExportInput{
				ReportType: graphql.AdminReportTypeMapSkillsProgress,
				Settings:   &graphql.CSVReportSettings{},
			},
		},
	}
	for _, tt := range tests {
		suite.Run(tt.name, func() {
			err := validateCSVExportInput(nil, tt.input)
			if tt.wantErr {
				suite.Require().Error(err)
				return
			}
			suite.Require().NoError(err)
		})
	}
}

// --- mapInputToFilters ---

func (suite *csvExportSuite) TestMapInputToFilters() {
	start := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 1, 31, 0, 0, 0, 0, time.UTC)
	strandKey := "x53ab"
	classroom := graphql.AdminRollupTypeClassroom

	tests := []struct {
		name  string
		input graphql.RequestCSVExportInput
		check func(got *models.EphemeralRecordEventFilters)
	}{
		{
			name: "combineByCourse true sets GroupBy and maps fields",
			input: graphql.RequestCSVExportInput{
				StartDate:       start,
				EndDate:         end,
				SelectedNodeID:  "district-1",
				ReportType:      graphql.AdminReportTypeOverallDi2,
				CombineByCourse: true,
				ShowAllWork:     false,
				Settings: &graphql.CSVReportSettings{
					ChildIDs:        []string{"school-1", "school-2"},
					Grades:          []string{"THIRD", "FOURTH"},
					CourseSISValues: []string{"Algebra: 3"},
					TeacherKaids:    []string{"kaid_teacher1"},
					CourseIDs:       []string{"course1"},
					StrandKey:       &strandKey,
					Bands:           []string{"179"},
					RollupType:      &classroom,
				},
			},
			check: func(got *models.EphemeralRecordEventFilters) {
				suite.Require().Equal("district-1", got.SelectedNodeID)
				suite.Require().Equal(models.OverallReportDI2, got.ReportType)
				suite.Require().True(got.StartDate.Equal(start))
				suite.Require().True(got.EndDate.Equal(end))
				suite.Require().Equal(end.Sub(start), got.Duration)
				suite.Require().True(slices.Equal([]string{"school-1", "school-2"}, got.ChildIDs))
				suite.Require().True(slices.Equal([]string{"COURSE_ID"}, got.GroupBy))
				suite.Require().True(got.CombineByCourse)
				suite.Require().True(got.OnlyTeacherCourses)
				suite.Require().Equal(models.ClassroomRollup, got.RollupType)
				suite.Require().Equal("x53ab", got.StrandKey)
				suite.Require().True(slices.Equal([]string{"course1"}, got.CourseIDs))
				suite.Require().True(slices.Equal([]string{"Algebra: 3"}, got.CourseSISs))
			},
		},
		{
			name: "combineByCourse false, showAllWork true, no rollup",
			input: graphql.RequestCSVExportInput{
				StartDate:       start,
				EndDate:         end,
				SelectedNodeID:  "district-2",
				ReportType:      graphql.AdminReportTypeMapDi2,
				CombineByCourse: false,
				ShowAllWork:     true,
				Settings: &graphql.CSVReportSettings{
					ChildIDs:   []string{},
					RollupType: nil,
					TestType:   new(graphql.LearningPathTestTypeMap),
				},
			},
			check: func(got *models.EphemeralRecordEventFilters) {
				suite.Require().Nil(got.GroupBy)
				suite.Require().False(got.CombineByCourse)
				suite.Require().False(got.OnlyTeacherCourses)
				suite.Require().Equal(models.RollupType(""), got.RollupType)
				suite.Require().Equal(models.LearningPathsOverallReportDI2, got.ReportType)
				suite.Require().Equal(models.LearningPathTestTypeMAP, got.TestType)
			},
		},
		{
			name: "nil optional fields map to zero values",
			input: graphql.RequestCSVExportInput{
				StartDate:       start,
				EndDate:         end,
				SelectedNodeID:  "district-3",
				ReportType:      graphql.AdminReportTypeKadSkillsProgress,
				CombineByCourse: false,
				ShowAllWork:     false,
				Settings: &graphql.CSVReportSettings{
					ChildIDs:  []string{},
					StrandKey: nil,
					Grades:    nil,
					CourseIDs: nil,
					Bands:     nil,
				},
			},
			check: func(got *models.EphemeralRecordEventFilters) {
				suite.Require().Empty(got.StrandKey)
				suite.Require().Nil(got.Grades)
				suite.Require().Nil(got.CourseIDs)
				suite.Require().Nil(got.Bands)
				suite.Require().Equal(models.KADSkillsProgress, got.ReportType)
			},
		},
	}
	for _, tt := range tests {
		suite.Run(tt.name, func() {
			got := mapInputToFilters(suite.KAContext(), tt.input)
			tt.check(got)
		})
	}
}

// --- mapInputToConfig ---

// configFullSettings populates every settings field so each per-type case
// proves mapInputToConfig selects exactly the right subset.
func configFullSettings() *graphql.CSVReportSettings {
	rollup := graphql.AdminRollupTypeClassroom
	return &graphql.CSVReportSettings{
		RollupType:      &rollup,
		ChildIDs:        []string{"school-1"},
		Grades:          []string{"5", "6"},
		CourseSISValues: []string{"sis-1"},
		TeacherKaids:    []string{"teacher-1"},
		CourseIDs:       []string{"course-1", "course-2"},
		DomainID:        generic.PointerOrNilIfZero("domain-1"),
		StrandKey:       generic.PointerOrNilIfZero("strand-a"),
		Bands:           []string{"band-1", "band-2"},
	}
}

func configInput(reportType graphql.AdminReportType) graphql.RequestCSVExportInput {
	return graphql.RequestCSVExportInput{
		StartDate:       time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		EndDate:         time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
		SelectedNodeID:  "district-1",
		ReportType:      reportType,
		CombineByCourse: true,
		ShowAllWork:     false,
		Settings:        configFullSettings(),
	}
}

// configExpectedBase is the base shared by every case. KALocale, CountryCode,
// and the key are intentionally unset: mapInputToConfig builds ownerless and
// resolves those later.
func configExpectedBase(reportType models.ReportType) models.DistrictReportConfigBase {
	return models.DistrictReportConfigBase{
		SelectedNodeID: "district-1",
		ChildIDs:       []string{"school-1"},
		ReportType:     reportType,
		StartDate:      time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		EndDate:        time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
		Duration:       24 * time.Hour,
		RollupType:     models.ClassroomRollup,
	}
}

func (suite *csvExportSuite) TestMapInputToConfigPerReportType() {
	tests := map[string]struct {
		graphqlType graphql.AdminReportType
		expected    models.DistrictReportConfig
	}{
		"overall": {
			graphqlType: graphql.AdminReportTypeOverallDi2,
			expected: &models.DistrictReportConfigOverall{
				DistrictReportConfigBase: configExpectedBase(models.OverallReportDI2),
				Grades:                   []models.GradeLevel{"5", "6"},
				GroupBy:                  []string{"COURSE_ID"},
				CombineByCourse:          true,
				CourseIDs:                []string{"course-1", "course-2"},
				OnlyTeacherCourses:       true,
				DomainID:                 "domain-1",
			},
		},
		"learning_paths_overall": {
			graphqlType: graphql.AdminReportTypeMapDi2,
			expected: &models.DistrictReportConfigLearningPathsOverall{
				DistrictReportConfigBase: configExpectedBase(models.LearningPathsOverallReportDI2),
				Grades:                   []models.GradeLevel{"5", "6"},
				GroupBy:                  []string{"COURSE_ID"},
				OnlyTeacherCourses:       true,
			},
		},
		"khanmigo": {
			graphqlType: graphql.AdminReportTypeKhanmigoUsage,
			expected: &models.DistrictReportConfigKhanmigo{
				DistrictReportConfigBase: configExpectedBase(models.KhanmigoUsage),
				Grades:                   []models.GradeLevel{"5", "6"},
				GroupBy:                  []string{"COURSE_ID"},
				CombineByCourse:          true,
				CourseIDs:                []string{"course-1", "course-2"},
				OnlyTeacherCourses:       true,
				DomainID:                 "domain-1",
			},
		},
		"kad_skills": {
			graphqlType: graphql.AdminReportTypeKadSkillsProgress,
			expected: &models.DistrictReportConfigKADSkills{
				DistrictReportConfigBase: configExpectedBase(models.KADSkillsProgress),
				CourseSISs:               []string{"sis-1"},
				Grades:                   []models.GradeLevel{"5", "6"},
				CourseIDs:                []string{"course-1", "course-2"},
				TeacherKaids:             []string{"teacher-1"},
			},
		},
		"learning_paths_skills": {
			graphqlType: graphql.AdminReportTypeMapSkillsProgress,
			expected: &models.DistrictReportConfigLearningPathsSkills{
				DistrictReportConfigBase: configExpectedBase(models.LearningPathsSkillsProgress),
				Grades:                   []models.GradeLevel{"5", "6"},
				TeacherKaids:             []string{"teacher-1"},
				StrandKey:                "strand-a",
				Bands:                    []string{"band-1", "band-2"},
			},
		},
		"mastery_student": {
			graphqlType: graphql.AdminReportTypeMasteryStudent,
			expected: &models.DistrictReportConfigMastery{
				DistrictReportConfigBase: configExpectedBase(models.MasteryStudent),
				CourseSISs:               []string{"sis-1"},
				Grades:                   []models.GradeLevel{"5", "6"},
				TeacherKaids:             []string{"teacher-1"},
			},
		},
		"mastery_class": {
			graphqlType: graphql.AdminReportTypeMasteryClass,
			expected: &models.DistrictReportConfigMastery{
				DistrictReportConfigBase: configExpectedBase(models.MasteryClass),
				CourseSISs:               []string{"sis-1"},
				Grades:                   []models.GradeLevel{"5", "6"},
				TeacherKaids:             []string{"teacher-1"},
			},
		},
		"course_challenge": {
			graphqlType: graphql.AdminReportTypeCourseChallengeSkills,
			expected: &models.DistrictReportConfigCourseChallenge{
				DistrictReportConfigBase: configExpectedBase(models.CourseChallengeSkills),
				CourseSISs:               []string{"sis-1"},
				Grades:                   []models.GradeLevel{"5", "6"},
				CourseIDs:                []string{"course-1", "course-2"},
				TeacherKaids:             []string{"teacher-1"},
			},
		},
	}

	for name, tt := range tests {
		suite.Run(name, func() {
			got, err := mapInputToConfig(configInput(tt.graphqlType))
			suite.Require().NoError(err)
			suite.Require().Equal(tt.expected, got)
		})
	}
}

func (suite *csvExportSuite) TestMapInputToConfigUnknownReportTypeError() {
	got, err := mapInputToConfig(configInput(graphql.AdminReportType("UNKNOWN")))
	suite.Require().Error(err)
	suite.Require().Nil(got)
}

func TestCSVExport(t *testing.T) {
	khantest.Run(t, new(csvExportSuite))
}
