// DistrictReportConfigAssessmentPerformance — Datastore model holding
// ASSESSMENT_PERFORMANCE admin-report filter fields, keyed by the
// EphemeralRecordEvent id.
package models

import (
	"context"

	"github.com/Khan/webapp/pkg/gcloud/datastore"
	"github.com/Khan/webapp/pkg/kacontext"
	"github.com/Khan/webapp/pkg/lib/timectx"
)

var DistrictReportConfigAssessmentPerformanceKind = datastore.RegisterKind(
	"DistrictReportConfigAssessmentPerformance",
	new(DistrictReportConfigAssessmentPerformance),
)

// DistrictReportConfigAssessmentPerformance persists AssessmentPerformance
// admin-report filter fields in Datastore entities keyed by the
// EphemeralRecordEvent id for simple loading.
type DistrictReportConfigAssessmentPerformance struct {
	datastore.BaseModel

	DistrictReportConfigBase

	// The students for the matching grades to include in the report.
	// If the grades is empty, it should be all grades in the selected
	// schools.
	Grades []GradeLevel `datastore:"grades,noindex"`

	// The ID of the assessment series to include data for. This maps to a set
	// of three individual assessments in the assessments database: one for
	// beginning of year, one for middle, and one for end.
	AssessmentSeriesID string `datastore:"assessment_series_id,noindex"`

	// The ID of the school year (as defined by the assessments database) to
	// include data for.
	SchoolYearID string `datastore:"school_year_id,noindex"`

	// True if the report is driven by the assessments "staging" database,
	// which contains fake assessments and test data.
	UsesStagingDB bool `datastore:"uses_staging_db,noindex"`
}

// MakeDistrictReportConfigAssessmentPerformanceKey creates a datastore NameKey
// for DistrictReportConfigAssessmentPerformance with the given id. This must
// match the owner's id (an EphemeralRecordEvent or
// EphemeralRecordEventSchedule) in order for them to be linked.
func MakeDistrictReportConfigAssessmentPerformanceKey(id string) *datastore.Key {
	return datastore.NameKey(DistrictReportConfigAssessmentPerformanceKind, id, nil)
}

// DistrictReportConfig interface implementation

func (m *DistrictReportConfigAssessmentPerformance) GetReportType() ReportType {
	return m.ReportType
}

func (m *DistrictReportConfigAssessmentPerformance) Base() *DistrictReportConfigBase {
	return &m.DistrictReportConfigBase
}

// SetOwner keys the config to the owner and inherits its expiration.
func (m *DistrictReportConfigAssessmentPerformance) SetOwner(owner ReportConfigOwner) {
	m.Key = MakeDistrictReportConfigAssessmentPerformanceKey(owner.GetID())
	m.ExpiresAt = owner.GetExpiresAt()
}

// Datastore Interface Implementations

func (
	m *DistrictReportConfigAssessmentPerformance,
) TransactionSafetyPolicy() datastore.TransactionSafetyOption {
	return datastore.WrittenInTransactionModel
}

func (m *DistrictReportConfigAssessmentPerformance) ModelHoldsUserSpecificData() bool {
	return false
}

func (m *DistrictReportConfigAssessmentPerformance) Load(ps []datastore.Property) error {
	_deprecatedRecordProps := []string{}
	validProps := datastore.RemoveProperties(ps, _deprecatedRecordProps)
	err := datastore.LoadStructAndUnmarshalJSON(m, validProps)

	return err
}

func (m *DistrictReportConfigAssessmentPerformance) PreSave(ctx context.Context) error {
	if err := m.BaseModel.PreSave(ctx); err != nil {
		return err
	}

	if err := datastore.CheckTransactionSafetyForPut(m); err != nil {
		return err
	}

	var ktx timectx.KAContext = kacontext.Upgrade(ctx)

	if m.CreatedAt.IsZero() {
		m.CreatedAt = ktx.Time().Now()
	}

	return nil
}

func (m *DistrictReportConfigAssessmentPerformance) Save() ([]datastore.Property, error) {
	return datastore.SaveStructAndMarshalJSON(m)
}
