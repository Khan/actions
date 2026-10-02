package resolvers

// Helpers for CSV export resolvers: validate and map GraphQL input, and
// translate ephemeral report/schedule records into AdminReport types.

import (
	"slices"

	"github.com/Khan/webapp/pkg/gcloud/datastore"
	"github.com/Khan/webapp/pkg/kacontext"
	"github.com/Khan/webapp/pkg/lib/errors"
	"github.com/Khan/webapp/pkg/lib/generic"
	"github.com/Khan/webapp/pkg/lib/timectx"
	"github.com/Khan/webapp/pkg/web"
	"github.com/Khan/webapp/pkg/web/gqlclient"
	"github.com/Khan/webapp/services/districts/generated/graphql"
	"github.com/Khan/webapp/services/districts/models"
	"github.com/Khan/webapp/services/districts/reporting"
	"github.com/Khan/webapp/services/districts/rostering"
)

func validateAndBuildFilters(
	ctx interface {
		kacontext.Base
		datastore.KAContext
		gqlclient.KAContext
		timectx.KAContext
		web.CookieContext
	},
	input graphql.RequestCSVExportInput,
) (*models.EphemeralRecordEventFilters, error) {
	if err := validateCSVExportInput(ctx, input); err != nil {
		return nil, err
	}
	return mapInputToFilters(ctx, input), nil
}

func mapEphemeralRecordToAdminReport(
	record *models.EphemeralRecordEvent,
	kaLocale string,
) *graphql.AdminReport {
	schools := make([]*string, len(record.ChildIDs))
	for i := range record.ChildIDs {
		schools[i] = new(record.ChildIDs[i])
	}
	courses := make([]*graphql.Course, len(record.CourseIDs))
	for i, courseID := range record.CourseIDs {
		courses[i] = &graphql.Course{ContentID: courseID, KaLocale: kaLocale}
	}
	var course *graphql.Course
	if len(courses) > 0 {
		course = courses[0]
	}
	var domain *graphql.Domain
	if record.DomainID != "" {
		domain = &graphql.Domain{ContentID: record.DomainID, KaLocale: kaLocale}
	}
	var assessmentSeriesID, assessmentsSchoolYearID *string
	var usesAssessmentsStagingDB *bool
	if record.ReportType == models.AssessmentPerformance {
		assessmentSeriesID = &record.AssessmentSeriesID
		assessmentsSchoolYearID = &record.AssessmentsSchoolYearID
		usesAssessmentsStagingDB = &record.UsesAssessmentsStagingDB
	}

	return &graphql.AdminReport{
		ID:                       record.GetID(),
		Kaid:                     record.Kaid,
		CreatedAt:                &record.CreatedAt,
		BlobCreatedAt:            &record.BlobCreatedAt,
		BlobExpiresAt:            &record.BlobExpiresAt,
		ObjectName:               &record.ObjectName,
		Status:                   reportStatusFromEphemeralStatus(record.EphemeralStatus),
		ReportType:               graphql.AdminReportType(record.ReportType),
		EndDate:                  record.EndDate,
		StartDate:                record.StartDate,
		Schools:                  schools,
		Grades:                   rostering.CastStrings[string](record.Grades),
		GradeLevels:              convertToDistrictGradeInfos(record.Grades, record.SelectedNodeID),
		CourseSISValues:          record.CourseSISs,
		TeacherKaids:             record.TeacherKaids,
		Course:                   course,
		Courses:                  courses,
		GroupBy:                  rostering.CastStrings[graphql.AdminReportField](record.GroupBy),
		Domain:                   domain,
		StrandKey:                generic.PointerOrNilIfZero(record.StrandKey),
		Bands:                    record.Bands,
		AssessmentSeriesID:       assessmentSeriesID,
		AssessmentsSchoolYearID:  assessmentsSchoolYearID,
		UsesAssessmentsStagingDb: usesAssessmentsStagingDB,
		FileName:                 &record.FileName,
		FileSize:                 &record.FileSize,
		NotifyByEmail:            &record.NotifyByEmail,
		EphemeralRecordEvent:     record,
		TotalSchools:             record.TotalSchools,
		NumSchoolsCompleted:      record.FinishedSchools,
		TotalDistricts:           record.TotalDistricts,
		NumDistrictsCompleted:    record.FinishedDistricts,
	}
}

func mapEphemeralRecordEventScheduleToAdminReportSchedule(
	record *models.EphemeralRecordEventSchedule,
	kaLocale string,
) *graphql.AdminReportSchedule {
	schools := make([]*string, len(record.ChildIDs))
	for i := range record.ChildIDs {
		schools[i] = new(record.ChildIDs[i])
	}
	courses := make([]*graphql.Course, len(record.CourseIDs))
	for i, courseID := range record.CourseIDs {
		courses[i] = &graphql.Course{ContentID: courseID, KaLocale: kaLocale}
	}
	var domain *graphql.Domain
	if record.DomainID != "" {
		domain = &graphql.Domain{ContentID: record.DomainID, KaLocale: kaLocale}
	}
	var assessmentSeriesID, assessmentsSchoolYearID *string
	var usesAssessmentsStagingDB *bool
	if record.ReportType == models.AssessmentPerformance {
		assessmentSeriesID = &record.AssessmentSeriesID
		assessmentsSchoolYearID = &record.AssessmentsSchoolYearID
		usesAssessmentsStagingDB = &record.UsesAssessmentsStagingDB
	}
	return &graphql.AdminReportSchedule{
		ID:         record.GetID(),
		Kaid:       record.Kaid,
		CreatedAt:  &record.CreatedAt,
		Status:     graphql.AdminReportScheduleStatusCreated,
		ReportType: graphql.AdminReportType(record.ReportType),
		EndDate:    record.EndDate,
		StartDate:  record.StartDate,
		Schools:    schools,
		Grades:     rostering.CastStrings[string](record.Grades),
		GradeLevels: convertToDistrictGradeInfos(
			record.Grades,
			record.SelectedNodeID,
		),
		CourseSISValues:          record.CourseSISs,
		TeacherKaids:             record.TeacherKaids,
		Courses:                  courses,
		GroupBy:                  rostering.CastStrings[graphql.AdminReportField](record.GroupBy),
		Domain:                   domain,
		StrandKey:                generic.PointerOrNilIfZero(record.StrandKey),
		Bands:                    record.Bands,
		AssessmentSeriesID:       assessmentSeriesID,
		AssessmentsSchoolYearID:  assessmentsSchoolYearID,
		UsesAssessmentsStagingDb: usesAssessmentsStagingDB,
		NotifyByEmail:            &record.NotifyByEmail,
		CronSchedule:             record.CronSchedule,
	}
}

// validateCSVExportInput dispatches to a per-report-type validator. Each
// validator owns the input checks for its report type.
func validateCSVExportInput(
	ctx interface {
		kacontext.Base
		datastore.KAContext
		gqlclient.KAContext
		timectx.KAContext
	},
	input graphql.RequestCSVExportInput,
) error {
	switch input.ReportType {
	case graphql.AdminReportTypeKadSkillsProgress:
		return validateKADSkillsProgressInput(input)
	case graphql.AdminReportTypeMapSkillsProgress:
		return validateMAPSkillsProgressInput(ctx, input)
	}
	return nil
}

func validateKADSkillsProgressInput(input graphql.RequestCSVExportInput) error {
	if len(input.Settings.CourseIDs) == 0 {
		return errors.Internal("missing courseID")
	}
	return nil
}

// validateMAPSkillsProgressInput validates strandKey and bandIds provided
// including validating strand/band IDs against the district's test catalog.
func validateMAPSkillsProgressInput(
	ctx interface {
		kacontext.Base
		datastore.KAContext
		gqlclient.KAContext
		timectx.KAContext
	},
	input graphql.RequestCSVExportInput,
) error {
	strandKey := generic.Deref(input.Settings.StrandKey)
	if strandKey != "" && len(input.Settings.Bands) == 0 {
		return errors.Wrap(errors.Internal(),
			"at least one band required", input.Settings.Bands)
	}

	if strandKey == "" && len(input.Settings.Bands) == 0 {
		return nil
	}

	district, err := districtLoader(ctx).Load(ctx, input.SelectedNodeID)
	if err != nil {
		return errors.Wrap(err, "Unable to fetch district", input.SelectedNodeID)
	}
	testCatalog, err := rostering.GetTestCatalogForDistrict(ctx, district)
	if err != nil {
		return errors.Wrap(err,
			"Unable to fetch test catalog for district",
			input.SelectedNodeID,
		)
	}

	strandIds := []string{""}
	bandIds := []string{}
	for _, t := range testCatalog {
		strandIds = append(strandIds, t.ID)
		for _, s := range t.Strands {
			strandIds = append(strandIds, s.ID)
		}
		for _, b := range t.Bands {
			bandIds = append(bandIds, b.ID)
		}
	}

	for _, bandId := range input.Settings.Bands {
		if !slices.Contains(bandIds, bandId) {
			return errors.Wrap(
				errors.Internal(), "invalid bandId",
				bandId,
			)
		}
	}
	if !slices.Contains(strandIds, strandKey) {
		return errors.Wrap(
			errors.Internal(),
			"invalid strandKey",
			strandKey,
		)
	}

	return nil
}

// rollupTypeFromGraphQL converts a GraphQL AdminRollupType pointer to the
// model's RollupType. A nil pointer produces an empty RollupType (no rollup).
func rollupTypeFromGraphQL(rollupType *graphql.AdminRollupType) models.RollupType {
	if rollupType == nil {
		return ""
	}
	return models.RollupType(*rollupType)
}

func mapInputToFilters(
	ctx web.CookieContext,
	input graphql.RequestCSVExportInput,
) *models.EphemeralRecordEventFilters {
	return &models.EphemeralRecordEventFilters{
		ChildIDs:                 input.Settings.ChildIDs,
		SelectedNodeID:           input.SelectedNodeID,
		ReportType:               models.ReportType(input.ReportType),
		StartDate:                input.StartDate,
		EndDate:                  input.EndDate,
		Duration:                 input.EndDate.Sub(input.StartDate),
		Grades:                   rostering.CastStrings[models.GradeLevel](input.Settings.Grades),
		CourseSISs:               input.Settings.CourseSISValues,
		TeacherKaids:             input.Settings.TeacherKaids,
		CourseIDs:                input.Settings.CourseIDs,
		GroupBy:                  reporting.GroupByFromCombineByCourse(input.CombineByCourse),
		CombineByCourse:          input.CombineByCourse,
		DomainID:                 generic.Deref(input.Settings.DomainID),
		StrandKey:                generic.Deref(input.Settings.StrandKey),
		Bands:                    input.Settings.Bands,
		OnlyTeacherCourses:       !input.ShowAllWork,
		RollupType:               rollupTypeFromGraphQL(input.Settings.RollupType),
		TestType:                 models.LearningPathTestType(generic.Deref(input.Settings.TestType)),
		AssessmentSeriesID:       generic.Deref(input.Settings.AssessmentSeriesID),
		AssessmentsSchoolYearID:  generic.Deref(input.Settings.AssessmentsSchoolYearID),
		UsesAssessmentsStagingDB: _shouldUseAssessmentsStagingDB(ctx),
	}
}

// _assessmentsStagingDBCookieName is the name of the cookie used to determine
// whether to use the staging database.
const _assessmentsStagingDBCookieName = "ax-db-staging"

// _shouldUseAssessmentsStagingDB checks whether the generated report should be
// driven by the assessments "staging" database, which contains fake
// assessments and test data. It is sent as a cookie, rather than a field on
// the mutation, for consistency with the assessments service and so that it
// can be controlled without a UI input.
func _shouldUseAssessmentsStagingDB(
	ctx web.CookieContext,
) bool {
	cookie, err := ctx.RequestCookie(_assessmentsStagingDBCookieName)
	return err != nil && cookie != nil && cookie.Value == "true"
}

// mapInputToConfig maps a CSV export request to the per-report-type config,
// reading the GraphQL input directly. Returns an error for report types with no
// config mapping; every report type that can be stored must map to a config.
//
// The config is built ownerless: its key is attached at store time, and the
// ctx-resolved fields (KALocale, CountryCode, IncludeKhanmigoUsage) are filled
// in later in the resolver.
func mapInputToConfig(
	input graphql.RequestCSVExportInput,
) (models.DistrictReportConfig, error) {
	base := models.DistrictReportConfigBase{
		SelectedNodeID: input.SelectedNodeID,
		ChildIDs:       input.Settings.ChildIDs,
		ReportType:     models.ReportType(input.ReportType),
		StartDate:      input.StartDate,
		EndDate:        input.EndDate,
		Duration:       input.EndDate.Sub(input.StartDate),
		RollupType:     rollupTypeFromGraphQL(input.Settings.RollupType),
	}
	grades := rostering.CastStrings[models.GradeLevel](input.Settings.Grades)

	switch models.ReportType(input.ReportType) {
	case models.OverallReportDI2:
		return &models.DistrictReportConfigOverall{
			DistrictReportConfigBase: base,
			Grades:                   grades,
			GroupBy:                  reporting.GroupByFromCombineByCourse(input.CombineByCourse),
			CombineByCourse:          input.CombineByCourse,
			CourseIDs:                input.Settings.CourseIDs,
			OnlyTeacherCourses:       !input.ShowAllWork,
			DomainID:                 generic.Deref(input.Settings.DomainID),
		}, nil
	case models.LearningPathsOverallReportDI2:
		return &models.DistrictReportConfigLearningPathsOverall{
			DistrictReportConfigBase: base,
			Grades:                   grades,
			GroupBy:                  reporting.GroupByFromCombineByCourse(input.CombineByCourse),
			OnlyTeacherCourses:       !input.ShowAllWork,
			TestType: models.LearningPathTestType(
				generic.Deref(input.Settings.TestType),
			),
		}, nil
	case models.KhanmigoUsage:
		return &models.DistrictReportConfigKhanmigo{
			DistrictReportConfigBase: base,
			Grades:                   grades,
			GroupBy:                  reporting.GroupByFromCombineByCourse(input.CombineByCourse),
			CombineByCourse:          input.CombineByCourse,
			CourseIDs:                input.Settings.CourseIDs,
			OnlyTeacherCourses:       !input.ShowAllWork,
			DomainID:                 generic.Deref(input.Settings.DomainID),
		}, nil
	case models.KADSkillsProgress:
		return &models.DistrictReportConfigKADSkills{
			DistrictReportConfigBase: base,
			CourseSISs:               input.Settings.CourseSISValues,
			Grades:                   grades,
			CourseIDs:                input.Settings.CourseIDs,
			TeacherKaids:             input.Settings.TeacherKaids,
		}, nil
	case models.LearningPathsSkillsProgress:
		return &models.DistrictReportConfigLearningPathsSkills{
			DistrictReportConfigBase: base,
			Grades:                   grades,
			TeacherKaids:             input.Settings.TeacherKaids,
			StrandKey:                generic.Deref(input.Settings.StrandKey),
			Bands:                    input.Settings.Bands,
			TestType: models.LearningPathTestType(
				generic.Deref(input.Settings.TestType),
			),
		}, nil
	case models.MasteryStudent, models.MasteryClass:
		return &models.DistrictReportConfigMastery{
			DistrictReportConfigBase: base,
			CourseSISs:               input.Settings.CourseSISValues,
			Grades:                   grades,
			TeacherKaids:             input.Settings.TeacherKaids,
			// IncludeUnits is not part of the CSV export input, so it stays
			// false on this path.
		}, nil
	case models.CourseChallengeSkills:
		return &models.DistrictReportConfigCourseChallenge{
			DistrictReportConfigBase: base,
			CourseSISs:               input.Settings.CourseSISValues,
			Grades:                   grades,
			CourseIDs:                input.Settings.CourseIDs,
			TeacherKaids:             input.Settings.TeacherKaids,
		}, nil
	default:
		return nil, errors.Internal(
			"no report config mapping for report type",
			errors.Fields{"reportType": input.ReportType},
		)
	}
}
