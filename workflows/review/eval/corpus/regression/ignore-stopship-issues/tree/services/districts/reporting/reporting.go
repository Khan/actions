package reporting

// report related datastore access layer functions and business logic
import (
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	protosCommon "github.com/Khan/webapp/genproto/go/pkg/gcloud"
	protos "github.com/Khan/webapp/genproto/go/services/districts"
	"github.com/Khan/webapp/pkg/analytics/events"
	"github.com/Khan/webapp/pkg/emails"
	"github.com/Khan/webapp/pkg/external/featureflags"
	"github.com/Khan/webapp/pkg/gcloud/datastore"
	"github.com/Khan/webapp/pkg/gcloud/datastore/crud"
	"github.com/Khan/webapp/pkg/gcloud/pubsub"
	"github.com/Khan/webapp/pkg/gcloud/secrets"
	"github.com/Khan/webapp/pkg/kacontext"
	"github.com/Khan/webapp/pkg/lib/errors"
	"github.com/Khan/webapp/pkg/lib/log"
	"github.com/Khan/webapp/pkg/lib/timectx"
	"github.com/Khan/webapp/pkg/web"
	"github.com/Khan/webapp/pkg/web/gqlclient"
	"github.com/Khan/webapp/services/districts/cross_service"
	"github.com/Khan/webapp/services/districts/generated/analytics_events"
	"github.com/Khan/webapp/services/districts/models"
	"github.com/Khan/webapp/services/districts/rostering"
)

var (
	ReportInProgress       = errors.Internal("A request is already in progress for this user.")
	ReportRequestCancelled = errors.Internal("The Report request has already been cancelled.")
	ReportRequestCompleted = errors.Internal("The Report request has already been completed.")
)

// GetEphemeraReportRecordForKaid returns the most recent EphemeralRecordEvent
// using the user kaid
func GetEphemeraReportRecordForKaid(
	ctx datastore.KAContext,
	kaid string,
) (*models.EphemeralRecordEvent, error) {
	query := datastore.NewQuery(models.EphemeralRecordEventKind).
		FilterField("kaid", "=", kaid).
		Order("-created_at")
	record, err := crud.GetFirst[models.EphemeralRecordEvent](ctx, query)
	return record, errors.Wrap(err, "kaid", kaid)
}

// GetEphemeralReportRecordsForQuery returns the topN most recent
// EphemeralRecordEvent records
// kaid       - kaid of interest
// partnershipID - if empty string no constraint on partnershipID
// reportType - optional when omitted returns all report types
// topN       - topN reports to be returned
//
//	(based upon created time))
func GetEphemeralReportRecordsForQuery(
	ctx interface {
		kacontext.Base
		datastore.KAContext
	},
	kaid string,
	districtID *string,
	partnershipID *string,
	reportType *models.ReportType,
	topN int,
	includeScheduled bool,
) ([]*models.EphemeralRecordEvent, error) {
	var records []*models.EphemeralRecordEvent
	query := datastore.NewQuery(models.EphemeralRecordEventKind)
	query = query.FilterField("kaid", "=", kaid)

	// Can't limit topN here since we don't know how many
	// records satisfy districtID and/or reportType

	query = query.Order("-created_at")

	results := ctx.Datastore().Run(ctx, query)
	for reportRecord, err := range crud.Iterate[models.EphemeralRecordEvent](results) {
		if err != nil {
			return nil, errors.Wrap(err,
				"kaid", kaid, "partnershipID", partnershipID, "reportType",
				reportType)
		}

		// Have to post query determine if any of
		// the filters need to be enforced
		// This is an AND operation so:
		//   * if neither are specified
		//     no check needed - just add
		//   * if both reportType and partnershipID
		//     specified then both need to be satisfied.
		//   * if either reportType or districtID
		//     specified then the respective constraint
		//     must be satisified for the record to be added

		// skip any reports that don't match the specified report type
		if reportType != nil && reportRecord.ReportType != *reportType {
			continue
		}

		// skip any reports that don't match the specified district
		if districtID != nil && reportRecord.SelectedNodeID != *districtID {
			continue
		}

		// skip any reports that don't match the specified partnership
		if partnershipID != nil && reportRecord.PartnershipID != *partnershipID {
			continue
		}

		if reportRecord.ScheduleID != nil &&
			!includeScheduled {
			continue
		}

		records = append(records, reportRecord)

		if len(records) >= topN {
			break
		}
	}

	return records, nil
}

// buildConfigFromFilters builds a report config from record filters: the
// filters-side analog of the resolver's mapInputToConfig. Context-resolved
// fields (KALocale, CountryCode, IncludeKhanmigoUsage) are already populated on
// the filters by the legacy resolver, so no further enrichment is needed. The
// key and expiration are left unset; storeOwnerWithConfig stamps both from the
// owner.
//
// Returns an error for report types with no config mapping; every report type
// that can be stored must map to a config.
//
// TODO(jesseday, eva-herzog): When the legacy csv export resolver is removed
// this should also be removed.  New resolvers use mapInputToConfig.
func buildConfigFromFilters(
	filters *models.EphemeralRecordEventFilters,
) (models.DistrictReportConfig, error) {
	base := models.DistrictReportConfigBase{
		SelectedNodeID: filters.SelectedNodeID,
		ChildIDs:       filters.ChildIDs,
		ReportType:     filters.ReportType,
		KALocale:       filters.KALocale,
		CountryCode:    filters.CountryCode,
		StartDate:      filters.StartDate,
		EndDate:        filters.EndDate,
		Duration:       filters.Duration,
		RollupType:     filters.RollupType,
	}
	switch filters.ReportType {
	case models.OverallReportDI2:
		return &models.DistrictReportConfigOverall{
			DistrictReportConfigBase: base,
			Grades:                   filters.Grades,
			GroupBy:                  filters.GroupBy,
			CombineByCourse:          filters.CombineByCourse,
			IncludeKhanmigoUsage:     filters.IncludeKhanmigoUsage,
			CourseIDs:                filters.CourseIDs,
			OnlyTeacherCourses:       filters.OnlyTeacherCourses,
			DomainID:                 filters.DomainID,
		}, nil
	case models.LearningPathsOverallReportDI2:
		return &models.DistrictReportConfigLearningPathsOverall{
			DistrictReportConfigBase: base,
			Grades:                   filters.Grades,
			GroupBy:                  filters.GroupBy,
			IncludeKhanmigoUsage:     filters.IncludeKhanmigoUsage,
			OnlyTeacherCourses:       filters.OnlyTeacherCourses,
			TestType:                 filters.TestType,
		}, nil
	case models.KhanmigoUsage:
		return &models.DistrictReportConfigKhanmigo{
			DistrictReportConfigBase: base,
			Grades:                   filters.Grades,
			GroupBy:                  filters.GroupBy,
			CombineByCourse:          filters.CombineByCourse,
			CourseIDs:                filters.CourseIDs,
			OnlyTeacherCourses:       filters.OnlyTeacherCourses,
			DomainID:                 filters.DomainID,
		}, nil
	case models.KADSkillsProgress:
		return &models.DistrictReportConfigKADSkills{
			DistrictReportConfigBase: base,
			CourseSISs:               filters.CourseSISs,
			Grades:                   filters.Grades,
			CourseIDs:                filters.CourseIDs,
			TeacherKaids:             filters.TeacherKaids,
		}, nil
	case models.LearningPathsSkillsProgress:
		return &models.DistrictReportConfigLearningPathsSkills{
			DistrictReportConfigBase: base,
			Grades:                   filters.Grades,
			TeacherKaids:             filters.TeacherKaids,
			StrandKey:                filters.StrandKey,
			Bands:                    filters.Bands,
		}, nil
	case models.MasteryStudent, models.MasteryClass:
		return &models.DistrictReportConfigMastery{
			DistrictReportConfigBase: base,
			CourseSISs:               filters.CourseSISs,
			Grades:                   filters.Grades,
			TeacherKaids:             filters.TeacherKaids,
			IncludeUnits:             filters.IncludeUnits,
		}, nil
	case models.CourseChallengeSkills:
		return &models.DistrictReportConfigCourseChallenge{
			DistrictReportConfigBase: base,
			CourseSISs:               filters.CourseSISs,
			Grades:                   filters.Grades,
			CourseIDs:                filters.CourseIDs,
			TeacherKaids:             filters.TeacherKaids,
		}, nil
	case models.AssessmentPerformance:
		return &models.DistrictReportConfigAssessmentPerformance{
			DistrictReportConfigBase: base,
			Grades:                   filters.Grades,
			AssessmentSeriesID:       filters.AssessmentSeriesID,
			SchoolYearID:             filters.AssessmentsSchoolYearID,
			UsesStagingDB:            filters.UsesAssessmentsStagingDB,
		}, nil
	default:
		return nil, errors.Internal(
			"no report config mapping for report type",
			errors.Fields{"reportType": filters.ReportType},
		)
	}
}

func CreateReportRequestForUser(
	ctx interface {
		kacontext.Base
		gqlclient.KAContext
		datastore.KAContext
		timectx.KAContext
	},
	kaid string,
	filters *models.EphemeralRecordEventFilters,
	notifyByEmail bool,
	cronSchedule string,
	writeToBigQuery bool,
) (*models.EphemeralRecordEvent, *models.EphemeralRecordEventSchedule, error) {
	logErrors := []any{
		"kaid", kaid, "reportType", filters.ReportType,
		"selectedNodeID", filters.SelectedNodeID,
		"startDate", filters.StartDate, "endDate", filters.EndDate,
	}
	switch filters.ReportType {
	case models.KADSkillsProgress:
		if len(filters.CourseIDs) == 0 {
			return nil, nil, errors.Internal("missing courseID")
		}
	case models.LearningPathsSkillsProgress:
		// When requesting all strands, it is not necessary to specify a band
		// (we assume all bands)
		if filters.StrandKey != "" && len(filters.Bands) == 0 {
			return nil, nil, errors.Wrap(errors.Internal(),
				"at least one band required", filters.Bands)
		}

		district, err := rostering.GetByID[models.District](ctx, filters.SelectedNodeID)
		if err != nil {
			return nil, nil, errors.Wrap(err, "Unable to fetch district", filters.SelectedNodeID)
		}
		testCatalog, err := rostering.GetTestCatalogForDistrict(ctx, district)
		if err != nil {
			return nil, nil, errors.Wrap(
				errors.Internal(),
				"Unable to fetch test catalog for district",
				filters.SelectedNodeID,
			)
		}

		// the strandID can be "", testID or a strand ID
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

		for _, bandId := range filters.Bands {
			if !slices.Contains(bandIds, bandId) {
				return nil, nil, errors.Wrap(
					errors.Internal(), "invalid bandId",
					bandId,
				)
			}
		}
		if !slices.Contains(strandIds, filters.StrandKey) {
			return nil, nil, errors.Wrap(
				errors.Internal(),
				"invalid strandKey",
				filters.StrandKey,
			)
		}
	}

	md, d, err := rostering.GetAdminAggregateByID(ctx, filters.SelectedNodeID)
	if err != nil {
		return nil, nil, errors.Wrap(err, logErrors...)
	}

	if md != nil {
		filters.PartnershipID = md.PartnershipID
	} else {
		filters.PartnershipID = d.PartnershipID
	}

	config, err := buildConfigFromFilters(filters)
	if err != nil {
		return nil, nil, errors.Wrap(err, logErrors...)
	}

	// When a user creates a schedule, we only create the
	// EphemeralRecordEventSchedule. When the EphemeralRecordEventSchedule
	// is ready to be run then we create a EphemeralRecordEvent for the
	// schedule. This creation process happens within districts-jobs.
	if cronSchedule != "" {
		ephemeralRecordEventSchedule := models.EphemeralRecordEventSchedule{
			BaseModel: datastore.BaseModel{
				Key: models.MakeEphemeralRecordEventScheduleKey(uuid.New().String()),
			},
			Status:                      models.EphemeralRecordEventScheduleStatusCreated,
			CreatedAt:                   ctx.Time().Now(),
			Kaid:                        kaid,
			EphemeralRecordEventFilters: *filters,
			NotifyByEmail:               notifyByEmail,
			CronSchedule:                cronSchedule,
			WriteToBigQuery:             writeToBigQuery,
		}
		err = storeOwnerWithConfig(ctx, &ephemeralRecordEventSchedule, config)
		return nil, &ephemeralRecordEventSchedule, errors.Wrap(err, logErrors...)
	}

	// First check for an existing report in progress
	// If a report is in progress throw an error, users
	// should cancel their report on the front-end before
	// requesting a new one.
	existingReports, err := GetEphemeralReportRecordsForQuery(
		ctx,
		kaid,
		nil,
		&filters.PartnershipID,
		&filters.ReportType,
		1,
		false,
	)

	if err != nil {
		// Ignore not found errors
		if !errors.Is(err, errors.NotFoundKind) {
			// for anything else, return the error
			return nil, nil, errors.Wrap(err, logErrors...)
		}
	} else if len(existingReports) != 0 {
		// A report exists
		for _, existingReport := range existingReports {
			if existingReport.EphemeralStatus == models.RunningStatus ||
				existingReport.EphemeralStatus == models.PendingStatus {
				logErrors = append(logErrors, "existing report ID", existingReport.GetID())
				return nil, nil, errors.Wrap(ReportInProgress, logErrors...)
			}
		}
	}

	ephemeralRecordEvent := models.EphemeralRecordEvent{
		BaseModel: datastore.BaseModel{
			Key: models.MakeEphemeralRecordEventKey(uuid.New().String()),
		},
		CreatedAt:                   ctx.Time().Now(),
		Kaid:                        kaid,
		EphemeralRecordEventFilters: *filters,
		EphemeralStatus:             models.PendingStatus,
		NotifyByEmail:               notifyByEmail,
	}
	if err := storeOwnerWithConfig(ctx, &ephemeralRecordEvent, config); err != nil {
		return nil, nil, errors.Wrap(err, logErrors...)
	}

	return &ephemeralRecordEvent, nil, nil
}

// storeOwnerWithConfig writes the owner (a record event or schedule) and its
// report config in a single transaction, so the two are created atomically and
// share a lifetime. The owner is put first: its PreSave assigns the
// expiration that SetOwner then copies onto the config. An owner and its config
// must always be created together.
func storeOwnerWithConfig(
	ctx interface {
		kacontext.Base
		datastore.KAContext
	},
	owner interface {
		models.ReportConfigOwner
		GetKey() *datastore.Key
	},
	config models.DistrictReportConfig,
) error {
	if owner == nil {
		return errors.Internal("storeOwnerWithConfig requires an owner")
	}
	if config == nil {
		return errors.Wrap(
			errors.Internal("storeOwnerWithConfig requires a config; an owner "+
				"and its config must be created together"),
			"ownerID", owner.GetID(),
			"reportType", owner.GetReportType(),
		)
	}
	_, err := ctx.Datastore().RunInTransaction(ctx, func(tx *datastore.Transaction) error {
		if _, e := tx.Put(owner.GetKey(), owner); e != nil {
			return errors.Wrap(e)
		}
		config.SetOwner(owner)
		if _, e := tx.Put(config.GetKey(), config); e != nil {
			return errors.Wrap(e)
		}
		return nil
	})
	return errors.Wrap(err,
		"ownerID", owner.GetID(),
		"reportType", owner.GetReportType(),
	)
}

// khanmigoConfig is implemented only by the config types that carry a
// Khanmigo-usage flag (currently DistrictReportConfigOverall). Keeping it a
// small consumer-side interface lets enrichConfigFromContext set the flag
// without fattening the core DistrictReportConfig interface.
type khanmigoConfig interface {
	models.DistrictReportConfig
	SetIncludeKhanmigoUsage(bool)
}

// enrichConfigFromContext fills the config fields that mapInputToConfig leaves
// empty because they're resolved from request context: locale, country, and
// (for the types that carry it) Khanmigo usage. A nil config is a no-op.
func enrichConfigFromContext(
	config models.DistrictReportConfig,
	kaLocale string,
	countryCode string,
	includeKhanmigo bool,
) {
	if config == nil {
		return
	}
	base := config.Base()
	base.KALocale = kaLocale
	base.CountryCode = countryCode
	if kc, ok := config.(khanmigoConfig); ok {
		kc.SetIncludeKhanmigoUsage(includeKhanmigo)
	}
}

func CreateAndStoreEphemeralRecordEvent(
	ctx interface {
		kacontext.Base
		datastore.KAContext
		timectx.KAContext
		web.KALocaleContext
		web.CountryContext
		log.KAContext
		web.AuthedUserContext
		featureflags.KAContext
	},
	filters *models.EphemeralRecordEventFilters,
	config models.DistrictReportConfig,
	requestedBy string,
	isCurrentUser bool,
	notifyByEmail bool,
) (*models.EphemeralRecordEvent, error) {
	logErrors := []any{
		"kaid", requestedBy, "reportType", filters.ReportType,
		"selectedNodeID", filters.SelectedNodeID,
		"startDate", filters.StartDate, "endDate", filters.EndDate,
	}

	partnershipID, _, err := ResolvePartnership(ctx, filters.SelectedNodeID)
	if err != nil {
		return nil, err
	}

	err = CheckNoReportInProgress(ctx, requestedBy, &partnershipID, &filters.ReportType)
	if err != nil {
		return nil, err
	}

	kaLocale := ctx.RequestKALocale()
	countryCode := ResolveCountryCode(ctx, isCurrentUser, requestedBy)
	includeKhanmigo := ResolveIncludeKhanmigo(ctx, filters.ReportType, requestedBy)

	filters.PartnershipID = partnershipID
	filters.KALocale = kaLocale
	filters.IncludeKhanmigoUsage = includeKhanmigo
	filters.CountryCode = countryCode

	ephemeralRecordEvent := models.EphemeralRecordEvent{
		BaseModel: datastore.BaseModel{
			Key: models.MakeEphemeralRecordEventKey(uuid.New().String()),
		},
		CreatedAt:                   ctx.Time().Now(),
		Kaid:                        requestedBy,
		EphemeralRecordEventFilters: *filters,
		EphemeralStatus:             models.PendingStatus,
		NotifyByEmail:               notifyByEmail,
	}

	enrichConfigFromContext(config, kaLocale, countryCode, includeKhanmigo)

	if err := storeOwnerWithConfig(ctx, &ephemeralRecordEvent, config); err != nil {
		return nil, errors.Wrap(err, logErrors...)
	}

	return &ephemeralRecordEvent, nil
}

func CreateAndStoreEphemeralRecordEventSchedule(
	ctx interface {
		kacontext.Base
		datastore.KAContext
		timectx.KAContext
		web.KALocaleContext
		web.CountryContext
		log.KAContext
		web.AuthedUserContext
		featureflags.KAContext
	},
	filters *models.EphemeralRecordEventFilters,
	config models.DistrictReportConfig,
	requestedBy string,
	isCurrentUser bool,
	notifyByEmail bool,
	cronSchedule string,
	writeToBiqQuery bool,
) (*models.EphemeralRecordEventSchedule, error) {
	logErrors := []any{
		"kaid", requestedBy, "reportType", filters.ReportType,
		"selectedNodeID", filters.SelectedNodeID,
		"startDate", filters.StartDate, "endDate", filters.EndDate,
	}

	partnershipID, _, err := ResolvePartnership(ctx, filters.SelectedNodeID)
	if err != nil {
		return nil, err
	}

	kaLocale := ctx.RequestKALocale()
	countryCode := ResolveCountryCode(ctx, isCurrentUser, requestedBy)
	includeKhanmigo := ResolveIncludeKhanmigo(ctx, filters.ReportType, requestedBy)

	filters.PartnershipID = partnershipID
	filters.KALocale = kaLocale
	filters.IncludeKhanmigoUsage = includeKhanmigo
	filters.CountryCode = countryCode

	ephemeralRecordEventSchedule := models.EphemeralRecordEventSchedule{
		BaseModel: datastore.BaseModel{
			Key: models.MakeEphemeralRecordEventScheduleKey(uuid.New().String()),
		},
		CreatedAt:                   ctx.Time().Now(),
		Kaid:                        requestedBy,
		EphemeralRecordEventFilters: *filters,
		Status:                      models.EphemeralRecordEventScheduleStatusCreated,
		NotifyByEmail:               notifyByEmail,
		CronSchedule:                cronSchedule,
		WriteToBigQuery:             writeToBiqQuery,
	}

	enrichConfigFromContext(config, kaLocale, countryCode, includeKhanmigo)

	if err := storeOwnerWithConfig(ctx, &ephemeralRecordEventSchedule, config); err != nil {
		return nil, errors.Wrap(err, logErrors...)
	}

	return &ephemeralRecordEventSchedule, nil
}

func SendAdminReportRequestPubsub(
	ctx interface {
		kacontext.Base
		pubsub.KAContext
		pubsub.LogContext
		secrets.KAContext
		timectx.KAContext
		log.KAContext
		web.FrontendAppNameContext
	},
	reportID string,
) error {
	adminReportRequest := protos.EphemeralRecordEvent{
		Info:                      new(protosCommon.Common), // SendProtobuf
		EphemeralRecordEventKeyId: reportID,
	}
	pubsubTopic := pubsub.TopicName{
		Name: "district_create_report_ephemeral_record_event",
	}
	result, resultErr := ctx.Pubsub().SendProtobuf(ctx, pubsubTopic, &adminReportRequest)
	pubsub.LogErrorAsync(ctx, result, resultErr, pubsubTopic)
	return nil
}

func SetReportAsComplete(
	ctx interface {
		kacontext.Base
		log.KAContext
		gqlclient.KAContext
		datastore.KAContext
		emails.KAContext
		events.PublishEventContext
		timectx.KAContext
	},
	reportID string,
	blobCreatedAt time.Time,
	blobExpiresAt time.Time,
	objectName string,
	jSONError *string,
	fileSize string,
	fileName string,
) error {
	userReportKey := models.MakeEphemeralRecordEventKey(reportID)
	usersReport := &models.EphemeralRecordEvent{}

	_, err := ctx.Datastore().RunInTransaction(ctx, func(tx *datastore.Transaction) error {
		// Re-initialize in case the transaction is retried.
		usersReport = &models.EphemeralRecordEvent{}

		innerErr := tx.Get(userReportKey, usersReport)
		if innerErr != nil {
			return innerErr
		}

		// A report exists, verify it has not been cancelled
		if usersReport.EphemeralStatus == models.CancelledStatus {
			return errors.Wrap(ReportRequestCancelled,
				"reportID", reportID, "kaid", usersReport.Kaid)
		}

		// Update the record
		usersReport.RecordStatusChange(ctx, models.DoneStatus, "")
		usersReport.BlobCreatedAt = blobCreatedAt
		usersReport.BlobExpiresAt = blobExpiresAt
		usersReport.ObjectName = objectName
		usersReport.FileSize = fileSize
		usersReport.FileName = fileName
		if jSONError != nil {
			usersReport.JSONError = []byte(*jSONError)
		}

		// Put it into the database.
		_, innerErr = tx.Put(userReportKey, usersReport)
		if innerErr != nil {
			return errors.Wrap(innerErr, "reportID", reportID, "kaid", usersReport.Kaid)
		}

		return nil
	})
	if err != nil {
		return err
	}

	// Lastly, send out confirmation email
	if usersReport.NotifyByEmail {
		kaLocale, err := rostering.GetDistrictLevelField(
			ctx, usersReport.SelectedNodeID, func(d *models.District) string {
				return d.KALocale
			})
		if err != nil {
			return err
		}

		var name string
		var email string

		umis, udis, err := rostering.GetManyUXIsFromKaid(
			ctx, usersReport.Kaid, &usersReport.PartnershipID)
		if err != nil {
			return err
		}

		switch {
		case len(umis) > 0:
			umi := umis[0]
			name = umi.GetFirstName(ctx)
			if name == "" {
				name = umi.GetFullName(ctx)
			}
			email = umi.GetEmail(ctx)
		case len(udis) > 0:
			udi := udis[0]
			name = udi.GetFirstName(ctx)
			if name == "" {
				name = udi.GetFullName(ctx)
			}
			email = udi.GetEmail(ctx)
		default:
			// This is namely the case for acting admins via capability
			// Get the email and username from the kaid
			_, _, name, email, err = cross_service.GetUserIdentifiers(ctx, usersReport.Kaid)
			if err != nil {
				return err
			}
			if strings.TrimSpace(name) == "" {
				name = "Admin"
			}
		}

		err = rostering.SendCSVReportReadyEmail(
			ctx, usersReport.Kaid, email, name, kaLocale)
		if err != nil {
			return errors.Wrap(err, "reportID", reportID, "kaid", usersReport.Kaid)
		}
	}

	SendAdminReportAnalyticsEvent(ctx, usersReport, AdminReportAnalyticsEventKindRequested)

	return nil
}

type TriFilter string

const (
	AllFilter  TriFilter = "ALL"
	OneFilter  TriFilter = "ONE"
	ManyFilter TriFilter = "MANY"
)

func getTriFilter(filters []string) TriFilter {
	if len(filters) == 0 {
		return AllFilter
	}
	if len(filters) == 1 {
		return OneFilter
	}
	return ManyFilter
}

type adminReportAnalyticsEventKind string

const (
	AdminReportAnalyticsEventKindRequested  adminReportAnalyticsEventKind = "requested"
	AdminReportAnalyticsEventKindCancelled  adminReportAnalyticsEventKind = "cancelled"
	AdminReportAnalyticsEventKindDownloaded adminReportAnalyticsEventKind = "downloaded"
)

func SendAdminReportAnalyticsEvent(
	ctx interface {
		events.PublishEventContext
		timectx.KAContext
		log.KAContext
		datastore.KAContext
	},
	report *models.EphemeralRecordEvent,
	eventKind adminReportAnalyticsEventKind,
) {
	generationTimeMinutes := report.BlobCreatedAt.Sub(report.CreatedAt).Minutes()
	if eventKind == AdminReportAnalyticsEventKindCancelled {
		generationTimeMinutes = 0
	}
	fileSizeInBytes := ParseSIBytes(report.FileSize)

	schoolFilter := AllFilter
	// We only check if the school filter is Many or One
	// when the total districts is one because in this world
	// of exporting at many levels of the hierarchy, the user
	// can only filter schools if they've also filtered down to
	// a single district.
	if report.TotalDistricts == 1 {
		schoolFilter = getTriFilter(report.ChildIDs)
	}

	if report.Kaid != "" && schoolFilter == ManyFilter {
		// it might be that the list of schools is specified but
		// matches the number of schools the user is an admin of,
		// in this case we should set the school filter to all
		udi, err := rostering.GetUDIFromDistrictIDAndKaid(ctx, report.SelectedNodeID, report.Kaid)
		if err == nil && len(udi.AdminOfSchoolKeys) == len(report.ChildIDs) {
			schoolFilter = AllFilter
		}
	}

	gradeFilter := AllFilter
	if len(report.Grades) == 1 {
		gradeFilter = OneFilter
	} else if len(report.Grades) > 1 {
		gradeFilter = ManyFilter
	}
	courseSISFilter := getTriFilter(report.CourseSISs)
	teacherFilter := getTriFilter(report.TeacherKaids)
	courseFilter := getTriFilter(report.CourseIDs)

	groupBy := ""
	switch report.ReportType {
	case models.KADSkillsProgress, models.LearningPathsSkillsProgress:
		groupBy = "BY_SKILL_AND_STUDENT"
	case models.LearningPathsOverallReportDI2, models.OverallReportDI2:
		if report.ByCourse() {
			groupBy = "BY_COURSE_AND_STUDENT"
		} else {
			groupBy = "BY_STUDENT"
		}
	case models.MasteryStudent:
		if report.IncludeUnits {
			groupBy = "BY_UNIT_AND_STUDENT"
		} else {
			groupBy = "BY_COURSE_AND_STUDENT"
		}
	case models.MasteryClass:
		if report.IncludeUnits {
			groupBy = "BY_UNIT_AND_CLASSROOM"
		} else {
			groupBy = "BY_COURSE_AND_CLASSROOM"
		}
	case models.KhanmigoUsage:
		groupBy = "BY_STUDENT"
	case models.CourseChallengeSkills:
		groupBy = "BY_SKILL_AND_STUDENT"
	}

	numDays := int64(report.EndDate.Sub(report.StartDate).Hours() / 24)

	if eventKind == AdminReportAnalyticsEventKindDownloaded {
		// STOPSHIP: update to v2 with ASSESSMENT_PERFORMANCE report type
		analytics_events.PublishDistrictsAdminCSVDownloadedTIV1(
			ctx,
			report.Kaid,
			report.SelectedNodeID,
			report.GetID(),
			report.CreatedAt,
			ctx.Time().Now(),
			analytics_events.ReportTypeDistrictsAdminCSVDownloadedTIEnum(report.ReportType),
			int64(report.TotalDistricts),
			int64(report.TotalSchools),
			fileSizeInBytes,
			report.FileSize,
			analytics_events.SchoolFilterDistrictsAdminCSVDownloadedTIEnum(schoolFilter),
			analytics_events.GradeFilterDistrictsAdminCSVDownloadedTIEnum(gradeFilter),
			analytics_events.CourseSISFilterDistrictsAdminCSVDownloadedTIEnum(courseSISFilter),
			analytics_events.TeacherFilterDistrictsAdminCSVDownloadedTIEnum(teacherFilter),
			analytics_events.CourseFilterDistrictsAdminCSVDownloadedTIEnum(courseFilter),
			report.OnlyTeacherCourses,
			analytics_events.GroupByDistrictsAdminCSVDownloadedTIEnum(groupBy),
			numDays,
		)
	} else {
		cancelled := eventKind == AdminReportAnalyticsEventKindCancelled

		// STOPSHIP: update to v2 with ASSESSMENT_PERFORMANCE report type
		analytics_events.PublishDistrictsAdminCSVRequestedTIV1(
			ctx,
			report.Kaid,
			report.SelectedNodeID,
			report.GetID(),
			report.CreatedAt,
			analytics_events.ReportTypeDistrictsAdminCSVRequestedTIEnum(report.ReportType),
			cancelled,
			generationTimeMinutes,
			// TODO(jesseday) See DIST-7283. TotalDistricts and TotalSchools are
			// only being set in the admin-report export job.  If the user
			// cancels before the job kicks off, these values and the
			// schoolFilter value will be incorrect.
			int64(report.TotalDistricts),
			int64(report.TotalSchools),
			fileSizeInBytes,
			report.FileSize,
			analytics_events.SchoolFilterDistrictsAdminCSVRequestedTIEnum(schoolFilter),
			analytics_events.GradeFilterDistrictsAdminCSVRequestedTIEnum(gradeFilter),
			analytics_events.CourseSISFilterDistrictsAdminCSVRequestedTIEnum(courseSISFilter),
			analytics_events.TeacherFilterDistrictsAdminCSVRequestedTIEnum(teacherFilter),
			analytics_events.CourseFilterDistrictsAdminCSVRequestedTIEnum(courseFilter),
			report.OnlyTeacherCourses,
			analytics_events.GroupByDistrictsAdminCSVRequestedTIEnum(groupBy),
			numDays,
		)
	}
}

func SetReportAsCancelled(
	ctx interface {
		kacontext.Base
		datastore.KAContext
		events.PublishEventContext
		timectx.KAContext
		log.KAContext
	},
	reportID string,
) error {
	userReportKey := models.MakeEphemeralRecordEventKey(reportID)
	usersReport := &models.EphemeralRecordEvent{}

	wasAlreadyFinished := false

	_, err := ctx.Datastore().RunInTransaction(ctx, func(tx *datastore.Transaction) error {
		wasAlreadyFinished = false
		// Re-initialize in case the transaction is retried.
		usersReport = &models.EphemeralRecordEvent{}

		innerErr := tx.Get(userReportKey, usersReport)
		if innerErr != nil {
			return errors.Wrap(innerErr, "reportID", reportID, "kaid", usersReport.Kaid)
		}

		if usersReport.EphemeralStatus == models.DoneStatus {
			wasAlreadyFinished = true
		}

		// A report exists, verify it has not already been cancelled
		if usersReport.EphemeralStatus == models.CancelledStatus {
			return errors.Wrap(ReportRequestCancelled,
				"reportID", reportID, "kaid", usersReport.Kaid)
		}

		// Update the record
		usersReport.RecordStatusChange(ctx, models.CancelledStatus, "")

		// Put it into the database.
		_, innerErr = tx.Put(userReportKey, usersReport)
		if innerErr != nil {
			return errors.Wrap(innerErr, "reportID", reportID, "kaid", usersReport.Kaid)
		}
		return nil
	})

	// only want to send the cancelled event if the report was not already
	// finished, because we "cancel" a report in order to create a new one
	// and we don't want to send the cancelled event in that case.
	if !wasAlreadyFinished {
		SendAdminReportAnalyticsEvent(ctx, usersReport, AdminReportAnalyticsEventKindCancelled)
	}

	return err
}
