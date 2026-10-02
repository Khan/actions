package resolvers

// A district administrator will request a report,
// and it will be generated asynchronously.
// The district administrator will be able to check
// on the status of their request via the UI.
// The district administrator will also be notified
// via email when their request is complete.
//
// Either way (email or request status UI) they will
// click on a link to download the report, and at that
// time a signed URL will be created and the district administrator
// will be redirected to that to download the file. The signed url
// will expire 30 minutes after it is created, so no one else will
// be able to download it. The administrator can get a new signed URL
// at any time, so long as the file still exists.

import (
	"context"
	"time"

	"github.com/Khan/webapp/pkg/analytics/events"
	"github.com/Khan/webapp/pkg/emails"
	"github.com/Khan/webapp/pkg/external/featureflags"
	"github.com/Khan/webapp/pkg/gcloud/datastore"
	"github.com/Khan/webapp/pkg/gcloud/pubsub"
	"github.com/Khan/webapp/pkg/gcloud/secrets"
	"github.com/Khan/webapp/pkg/kacontext"
	"github.com/Khan/webapp/pkg/khan/acl"
	"github.com/Khan/webapp/pkg/lib/errors"
	"github.com/Khan/webapp/pkg/lib/generic"
	"github.com/Khan/webapp/pkg/lib/log"
	"github.com/Khan/webapp/pkg/lib/timectx"
	"github.com/Khan/webapp/pkg/web"
	"github.com/Khan/webapp/pkg/web/gqlclient"
	"github.com/Khan/webapp/services/districts"
	"github.com/Khan/webapp/services/districts/generated/automap"
	"github.com/Khan/webapp/services/districts/generated/graphql"
	"github.com/Khan/webapp/services/districts/models"
	"github.com/Khan/webapp/services/districts/reporting"
	"github.com/Khan/webapp/services/districts/rostering"
)

const bucket = "ephemeral.khanacademy.org"

func (r *Resolver) AdminReport() graphql.AdminReportResolver {
	return &AdminReportResolver{r}
}

type AdminReportResolver struct{ *Resolver }

// SignURLForReport returns the fields for a school
func (r *mutationResolver) SignURLForReport(
	ctx context.Context,
	id string,
	timeout time.Duration,
) (*graphql.SignURLForReportResult, error) {
	var ktx interface {
		kacontext.Base
		datastore.KAContext
		timectx.KAContext
		log.KAContext
		web.AuthedUserContext
		web.AuthedServiceContext
		events.PublishEventContext
	} = kacontext.Upgrade(ctx)
	result := graphql.SignURLForReportResult{
		URL:   nil,
		Error: nil,
	}
	isServiceAdmin := ktx.RequestIsServiceAdminQuery()
	if !(isServiceAdmin || acl.IsLoggedIn(ktx, acl.PhantomProhibited)) {
		return automap.SignURLForReportResultErr(ktx,
			errors.Wrap(errors.Unauthorized(), "id", id))
	}
	record, err := rostering.GetByID[models.EphemeralRecordEvent](ktx, id)
	if err != nil {
		return automap.SignURLForReportResultErr(ktx, err)
	}

	fileBytesSize := reporting.ParseSIBytes(record.FileSize)
	// adjust default timeout if file is too large
	timeout = reporting.SizedTimeout(fileBytesSize, timeout)

	if !isServiceAdmin {
		isOwner := acl.IsCurrentUser(ktx, record.Kaid)
		if !isOwner {
			return automap.SignURLForReportResultErr(ktx,
				errors.Wrap(errors.Unauthorized(
					"SignURLForReport is not Record owner"), "id", id,
					"ownerKaid", record.Kaid))
		}
	}
	signedURL, signErr := districts.GenerateV4GetObjectSignedURL(
		ktx, r.CredentialsClient, bucket, record.ObjectName, timeout)

	if signedURL != "" {
		result.URL = &signedURL
	}

	if signErr != nil {
		return automap.SignURLForReportResultErr(ktx,
			errors.Wrap(signErr, "id", id))
	}

	reporting.SendAdminReportAnalyticsEvent(
		ktx,
		record,
		reporting.AdminReportAnalyticsEventKindDownloaded,
	)

	return &result, nil
}

// GetLastNAdminReportsForUser returns the most recent
// admin report(s) for a user if any exist
// kaid of interest
// districtID - optional when omitted no constraint on districtID
// reportType - optional when omitted returns all report types
// topNResults- optional when omitted top 10 reports are returned
//
//	(based upon created time))
func (r *queryResolver) GetLastNAdminReportsForUser(
	ctx context.Context,
	kaid string,
	districtIDPtr *string,
	partnershipIDPtr *string,
	reportType *string,
	topNResults *int,
) (*graphql.GetLastNAdminReportsForUserResult, error) {
	var ktx interface {
		kacontext.Base
		datastore.KAContext
		log.KAContext
		web.AuthedUserContext
		web.AuthedServiceContext
		web.KALocaleContext
	} = kacontext.Upgrade(ctx)
	isServiceAdmin := ktx.RequestIsServiceAdminQuery()
	if !isServiceAdmin && !acl.IsCurrentUser(ktx, kaid) {
		return automap.GetLastNAdminReportsForUserResultErr(ktx,
			errors.Wrap(errors.Unauthorized(), "kaid", kaid))
	}

	numResults := 10
	if topNResults != nil {
		numResults = *topNResults
	}

	var typedReportTypePtr *models.ReportType
	if reportType != nil {
		typedReportType := models.ReportType(*reportType)
		typedReportTypePtr = &typedReportType
	}
	records, err := reporting.GetEphemeralReportRecordsForQuery(ktx,
		kaid,
		districtIDPtr,
		partnershipIDPtr,
		typedReportTypePtr,
		numResults,
		false,
	)
	if err != nil {
		return automap.GetLastNAdminReportsForUserResultErr(ktx, err)
	}
	kaLocale := ktx.RequestKALocale()
	reports := make([]*graphql.AdminReport, len(records))
	for i, record := range records {
		reports[i] = mapEphemeralRecordToAdminReport(record, kaLocale)
	}

	return &graphql.GetLastNAdminReportsForUserResult{
		AdminReports: reports,
	}, nil
}

func reportStatusFromEphemeralStatus(status models.EphemeralStatus) graphql.AdminReportStatus {
	for _, reportStatus := range graphql.AllAdminReportStatus {
		if status == models.EphemeralStatusFromText(reportStatus.String()) {
			return reportStatus
		}
	}
	// default is running
	return graphql.AdminReportStatusRunning
}

func (r *AdminReportResolver) SelectedNode(
	ctx context.Context,
	report *graphql.AdminReport,
) (graphql.AdminAggregate, error) {
	var ktx interface {
		kacontext.Base
		datastore.KAContext
		timectx.KAContext
	} = kacontext.Upgrade(ctx)

	// same as the admin report
	acl.OpenAccess()

	md, d, err := rostering.GetAdminAggregateByID(
		ktx, report.EphemeralRecordEvent.SelectedNodeID)
	return mapAdminAggregate(md, d), err
}

func (r *AdminReportResolver) Children(
	ctx context.Context,
	report *graphql.AdminReport,
) ([]graphql.AdminNode, error) {
	var ktx interface {
		kacontext.Base
		datastore.KAContext
		timectx.KAContext
	} = kacontext.Upgrade(ctx)

	// same as the admin report
	acl.OpenAccess()

	mds, ds, schools, err := rostering.GetAdminNodes(
		ktx, report.EphemeralRecordEvent.ChildIDs)
	return mapAdminNodes(mds, ds, schools), err
}

// To Be Deprecated and replaced by RequestCSVExport and ScheduleCSVExport
func (r *mutationResolver) RequestAdminReportCSV(
	ctx context.Context,
	kaid string,
	districtID string,
	schools []string,
	selectedNodeID string,
	childIDs []string,
	reportType graphql.AdminReportType,
	onlyTeacherCourses bool,
	startDate time.Time,
	endDate time.Time,
	grades []string,
	courseSISValues []string,
	teacherKaids []string,
	courseIDPtr *string,
	courseIDs []string,
	groupBy []graphql.AdminReportField,
	domainIDPtr *string,
	strandKeyPtr *string,
	bands []string,
	notifyByEmail bool,
	kaLocalePtr *string,
	cronSchedule *string,
	writeToBigQuery *bool,
) (*graphql.RequestAdminReportResult, error) {
	var ktx interface {
		kacontext.Base
		datastore.KAContext
		log.KAContext
		web.AuthedServiceContext
		web.AuthedUserContext
		web.KALocaleContext
		web.CountryContext
		pubsub.KAContext
		pubsub.LogContext
		secrets.KAContext
		timectx.KAContext
		web.FrontendAppNameContext
		featureflags.KAContext
		gqlclient.KAContext
	} = kacontext.Upgrade(ctx)

	isServiceAdminQuery := ktx.RequestIsServiceAdminQuery()
	isCurrentUser := acl.IsCurrentUser(ktx, kaid)

	if !isCurrentUser && !isServiceAdminQuery {
		return automap.RequestAdminReportResultErr(ktx, errors.Unauthorized())
	}

	if selectedNodeID == "" {
		selectedNodeID = districtID
		childIDs = schools
	}

	var strandKey string
	if generic.Deref(courseIDPtr) != "" {
		courseIDs = append(courseIDs, *courseIDPtr)
	}
	if strandKeyPtr != nil {
		strandKey = *strandKeyPtr
	}

	kaLocale := generic.DerefWithDefault(kaLocalePtr, ktx.RequestKALocale())

	var countryCode string

	if isCurrentUser {
		var err error

		countryCode, err = ktx.RequestCountryCode()
		if err != nil {
			ktx.Log().Error(errors.Wrap(err, "kaid", kaid))
		}
	}

	includeKhanmigoInOverall := false
	if reportType == graphql.AdminReportTypeOverallDi2 ||
		reportType == graphql.AdminReportTypeMapDi2 {
		if user, err := ktx.RequestUser(); err == nil && user != nil && user.Kaid != "" {
			includeKhanmigoInOverall, _ = ktx.FeatureFlags().IsOn(
				ktx,
				"khanmigo-in-overall-csv",
				featureflags.Attributes{Kaid: kaid},
			)
		}
	}

	// TODO(eva-herzog, jesseday, kalisjoshua): Once the KAC content override
	// is removed, CP-9741, update `EphemeralRecordEvent` to pass in course IDs
	// and KA locales for each course, instead of using the request-locale.
	filters := &models.EphemeralRecordEventFilters{
		ChildIDs:             childIDs,
		SelectedNodeID:       selectedNodeID,
		ReportType:           models.ReportType(reportType),
		StartDate:            startDate,
		EndDate:              endDate,
		Duration:             endDate.Sub(startDate),
		Grades:               rostering.CastStrings[models.GradeLevel](grades),
		CourseSISs:           courseSISValues,
		TeacherKaids:         teacherKaids,
		CourseIDs:            courseIDs,
		GroupBy:              rostering.CastStrings[string](groupBy),
		DomainID:             generic.Deref(domainIDPtr),
		StrandKey:            strandKey,
		Bands:                bands,
		KALocale:             kaLocale,
		CountryCode:          countryCode,
		IncludeKhanmigoUsage: includeKhanmigoInOverall,
		OnlyTeacherCourses:   onlyTeacherCourses,
	}

	// TODO(michaelpolyak): Once the KAC content override is removed in CP-9741,
	// `kaLocale` can be used in instead of the request-locale.
	userKALocale := ktx.RequestKALocale()

	// Create request
	ephemeralRecordEventRequest, ephemeralRecordEventSchedule, err := reporting.CreateReportRequestForUser(
		ktx,
		kaid,
		filters,
		notifyByEmail,
		generic.Deref(cronSchedule),
		generic.Deref(writeToBigQuery),
	)
	if err != nil {
		return automap.RequestAdminReportResultErr(ktx, err)
	}

	if ephemeralRecordEventSchedule != nil {
		return &graphql.RequestAdminReportResult{
			AdminReportSchedule: mapEphemeralRecordEventScheduleToAdminReportSchedule(
				ephemeralRecordEventSchedule,
				userKALocale,
			),
		}, nil
	}

	// Send pub/sub request to start generating report
	err = reporting.SendAdminReportRequestPubsub(ktx, ephemeralRecordEventRequest.GetID())
	if err != nil {
		return automap.RequestAdminReportResultErr(ktx, err)
	}

	adminReport := mapEphemeralRecordToAdminReport(
		ephemeralRecordEventRequest, userKALocale)
	return &graphql.RequestAdminReportResult{
		AdminReport: adminReport,
	}, nil
}

func (r *mutationResolver) SetAdminReportComplete(
	ctx context.Context,
	reportID string,
	blobCreatedAt time.Time,
	blobExpiresAt time.Time,
	objectName string,
	jsonError *string,
	fileSize string,
	fileName string,
	updatedAt time.Time,
) (*graphql.SetAdminReportCompleteResult, error) {
	var ktx interface {
		kacontext.Base
		gqlclient.KAContext
		datastore.KAContext
		log.KAContext
		emails.KAContext
		web.AuthedServiceContext
		events.PublishEventContext
		timectx.KAContext
	} = kacontext.Upgrade(ctx)

	isServiceAdminQuery := ktx.RequestIsServiceAdminQuery()

	if !isServiceAdminQuery {
		return automap.SetAdminReportCompleteResultErr(ktx,
			errors.Unauthorized())
	}

	err := reporting.SetReportAsComplete(
		ktx,
		reportID,
		blobCreatedAt,
		blobExpiresAt,
		objectName,
		jsonError,
		fileSize,
		fileName,
	)
	if err != nil {
		return automap.SetAdminReportCompleteResultErr(ktx, err)
	}
	// Return results
	return &graphql.SetAdminReportCompleteResult{}, nil
}

func (r *mutationResolver) SetAdminReportCancelled(
	ctx context.Context,
	reportID string,
) (*graphql.SetAdminReportCancelledResult, error) {
	var ktx interface {
		kacontext.Base
		datastore.KAContext
		log.KAContext
		web.AuthedServiceContext
		web.AuthedUserContext
		events.PublishEventContext
		timectx.KAContext
	} = kacontext.Upgrade(ctx)

	isServiceAdmin := ktx.RequestIsServiceAdminQuery()

	if !(isServiceAdmin || acl.IsLoggedIn(ktx, acl.PhantomProhibited)) {
		return automap.SetAdminReportCancelledResultErr(ktx,
			errors.Unauthorized())
	}

	record, err := rostering.GetByID[models.EphemeralRecordEvent](ktx, reportID)
	if err != nil {
		return automap.SetAdminReportCancelledResultErr(ktx, err)
	}

	if !isServiceAdmin {
		isOwner := acl.IsCurrentUser(ktx, record.Kaid)
		if !isOwner {
			return automap.SetAdminReportCancelledResultErr(ktx,
				errors.Unauthorized(
					"message",
					"SetAdminReportCancelled: user is not record owner",
					"kaid", record.Kaid))
		}
	}

	err = reporting.SetReportAsCancelled(ktx, reportID)
	if err != nil {
		return automap.SetAdminReportCancelledResultErr(ktx, err)
	}

	// Return results
	return &graphql.SetAdminReportCancelledResult{}, nil
}

func (r *mutationResolver) RequestCSVExport(
	ctx context.Context,
	input graphql.RequestCSVExportInput,
) (*graphql.RequestCSVExportResult, error) {
	var ktx interface {
		kacontext.Base
		datastore.KAContext
		featureflags.KAContext
		log.KAContext
		pubsub.KAContext
		pubsub.LogContext
		secrets.KAContext
		timectx.KAContext
		web.AuthedServiceContext
		web.AuthedUserContext
		web.CookieContext
		web.CountryContext
		web.FrontendAppNameContext
		web.KALocaleContext
		gqlclient.KAContext
	} = kacontext.Upgrade(ctx)

	// Permission check is called at the resolver level to comply with ADR-211
	isCurrentUser, err := reporting.AuthorizeCSVExportRequest(ktx, input.RequestedBy)
	if err != nil {
		return automap.RequestCSVExportResultErr(ktx, err)
	}

	filters, err := validateAndBuildFilters(ktx, input)
	if err != nil {
		return automap.RequestCSVExportResultErr(ktx, err)
	}

	// The config is written atomically with the record event by
	// CreateAndStoreEphemeralRecordEvent, keyed by the record's ID.
	//
	// TODO(jesseday): Districts-jobs still reads the filters from the
	// schedule.  Once the filter fields are deprecated in districts-jobs
	// we can update validateAndBuildFilters to return config using this
	// mapInputToConfig function and drop mapInputToFilters.
	config, err := mapInputToConfig(input)
	if err != nil {
		return automap.RequestCSVExportResultErr(ktx, err)
	}

	record, err := reporting.CreateAndStoreEphemeralRecordEvent(ktx, filters, config,
		input.RequestedBy, isCurrentUser, input.NotifyByEmail)
	if err != nil {
		return automap.RequestCSVExportResultErr(ktx, err)
	}

	err = reporting.SendAdminReportRequestPubsub(ktx, record.GetID())
	if err != nil {
		return automap.RequestCSVExportResultErr(ktx, err)
	}

	adminReport := mapEphemeralRecordToAdminReport(
		record, ktx.RequestKALocale())
	return &graphql.RequestCSVExportResult{
		AdminReport: adminReport,
	}, nil
}

func (r *mutationResolver) ScheduleCSVExport(
	ctx context.Context,
	input graphql.ScheduleCSVExportInput,
) (*graphql.ScheduleCSVExportResult, error) {
	var ktx interface {
		kacontext.Base
		datastore.KAContext
		featureflags.KAContext
		log.KAContext
		timectx.KAContext
		web.AuthedServiceContext
		web.AuthedUserContext
		web.CookieContext
		web.CountryContext
		web.KALocaleContext
		gqlclient.KAContext
	} = kacontext.Upgrade(ctx)

	if err := reporting.ValidateCronSchedule(input.CronSchedule); err != nil {
		return automap.ScheduleCSVExportResultErr(ktx, err)
	}

	// Permission check is called at the resolver level to comply with ADR-211
	isCurrentUser, err := reporting.AuthorizeCSVExportRequest(ktx, input.Request.RequestedBy)
	if err != nil {
		return automap.ScheduleCSVExportResultErr(ktx, err)
	}

	filters, err := validateAndBuildFilters(ktx, *input.Request)
	if err != nil {
		return automap.ScheduleCSVExportResultErr(ktx, err)
	}

	// The config is written atomically with the schedule by
	// CreateAndStoreEphemeralRecordEventSchedule, keyed by the schedule's ID.
	//
	// TODO(jesseday): Districts-jobs still reads the filters from the
	// schedule.  Once the filter fields are deprecated in districts-jobs
	// we can update validateAndBuildFilters to return config using this
	// mapInputToConfig function and drop mapInputToFilters.
	config, err := mapInputToConfig(*input.Request)
	if err != nil {
		return automap.ScheduleCSVExportResultErr(ktx, err)
	}

	record, err := reporting.CreateAndStoreEphemeralRecordEventSchedule(
		ktx,
		filters,
		config,
		input.Request.RequestedBy,
		isCurrentUser,
		input.Request.NotifyByEmail,
		input.CronSchedule,
		input.WriteToBigQuery,
	)
	if err != nil {
		return automap.ScheduleCSVExportResultErr(ktx, err)
	}

	adminReportSchedule := mapEphemeralRecordEventScheduleToAdminReportSchedule(
		record, ktx.RequestKALocale())
	return &graphql.ScheduleCSVExportResult{
		AdminReportSchedule: adminReportSchedule,
	}, nil
}
