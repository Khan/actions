package models

// Model representing an ephemeral record event
//
// This may be thought of as an audit record for securely sharing
// sensitive self-expiring files with external third parties
// using short-lived GCS Signed URLs.
//
// We use these records to track what CSV Admin Reports have been requested
// and by who, and what their fulfillment status is.
//
// This helps us limit access only to the original requestor
// and provide security audit controls as to who was able to request what

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/Khan/webapp/pkg/gcloud/datastore"
	"github.com/Khan/webapp/pkg/kacontext"
	"github.com/Khan/webapp/pkg/lib/timectx"
)

var EphemeralRecordEventKind = datastore.
	RegisterKind("EphemeralRecordEvent", new(EphemeralRecordEvent))

type EphemeralRecordEvent struct {
	// Defines Key, ModificationTimestamp, etc.
	datastore.BaseModel

	// time of initial request
	CreatedAt time.Time `datastore:"created_at,omitempty"`

	ExpiresAt time.Time `datastore:"expires_at,omitempty"`

	// The kaid of the UserData associated with this request
	Kaid string `datastore:"kaid"`

	EphemeralRecordEventFilters

	// time requested file was written to gcs
	BlobCreatedAt time.Time `datastore:"blob_created_at,noindex,omitempty"`
	// time request gcs file expires
	BlobExpiresAt time.Time `datastore:"blob_expires_at,noindex,omitempty"`
	// the size of the file that was written to gcs
	FileSize string `datastore:"file_size,noindex,omitempty"`

	// the name of the file that was written to gcs
	FileName string `datastore:"file_name,noindex,omitempty"`

	// ObjectName is the Google Cloud Storage objectName for the bucket
	// it must consist entirely of valid UTF-8-encoded runes.
	// The full specification for valid object names can be found at:
	//   https://cloud.google.com/storage/docs/naming-objects
	ObjectName string `datastore:"object_name,noindex,omitempty"`

	// If a report failed, we keep the failure report
	JSONError []byte `datastore:"json_error,noindex"`

	// The current status of the ephemeral event.
	// It should be a value in the EphemeralStatus enum.
	EphemeralStatus EphemeralStatus `datastore:"ephemeral_status"`

	// Whether the user should be notified by email or not when their report
	// is ready
	NotifyByEmail bool `datastore:"notify_by_email,noindex,omitempty"`

	// values for progress updatings
	TotalSchools      int `datastore:"total_schools,noindex,omitempty"`
	TotalDistricts    int `datastore:"total_districts,noindex,omitempty"`
	FinishedSchools   int `datastore:"finished_schools,noindex,omitempty"`
	FinishedDistricts int `datastore:"finished_districts,noindex,omitempty"`

	// How many times this report job has been attempted
	AttemptNumber int `datastore:"attempt_number,noindex,omitempty"`

	// Ordered log of status transitions for this record.
	StatusHistory []StatusHistoryEntry `datastore:"-" kadatastore_json:"status_history"`

	// A foreign key to  EphemeralRecordEventSchedule
	ScheduleID *string `datastore:"schedule_id,omitempty"`
}

type StatusHistoryEntry struct {
	From    EphemeralStatus `json:"from"`
	To      EphemeralStatus `json:"to"`
	At      time.Time       `json:"at"`
	Message string          `json:"message,omitempty"`
}

func (r *EphemeralRecordEvent) RecordStatusChange(
	ctx timectx.KAContext,
	to EphemeralStatus,
	message string,
) {
	r.StatusHistory = append(r.StatusHistory, StatusHistoryEntry{
		From:    r.EphemeralStatus,
		To:      to,
		At:      ctx.Time().Now(),
		Message: message,
	})
	r.EphemeralStatus = to
}

func (m *EphemeralRecordEvent) TransactionSafetyPolicy() datastore.TransactionSafetyOption {
	return datastore.WrittenInTransactionModel
}

func (m *EphemeralRecordEvent) ModelHoldsUserSpecificData() bool {
	return false
}

// ByCourse returns whether the report should be grouped by course.
// Used by the overall report.
func (r *EphemeralRecordEvent) ByCourse() bool {
	return slices.Equal(r.GroupBy, []string{"COURSE_ID"})
}

var _deprecatedRecordProps = []string{
	"json_request", // we no longer use this field
	"udi_key_id",
	"district_key_id",
	"schools",
	"updated_at", // no longer stored; use ModificationTimestamp
	"curriculum_code",
}

func (m *EphemeralRecordEvent) Load(ps []datastore.Property) error {
	validProps := datastore.RemoveProperties(ps, _deprecatedRecordProps)
	err := datastore.LoadStructAndUnmarshalJSON(m, validProps)
	if m.CourseID != "" && !slices.Contains(m.CourseIDs, m.CourseID) {
		m.CourseIDs = append(m.CourseIDs, m.CourseID)
	}
	return err
}

func (m *EphemeralRecordEvent) PreSave(ctx context.Context) error {
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

	if m.ExpiresAt.IsZero() {
		m.ExpiresAt = ktx.Time().Now().AddDate(2, 0, 0)
	}

	return nil
}

func (m *EphemeralRecordEvent) Save() ([]datastore.Property, error) {
	return datastore.SaveStructAndMarshalJSON(m)
}

// GetID returns the UUID (aka) the Key.Name
func (m *EphemeralRecordEvent) GetID() string {
	return m.Key.Name
}

// GetReportType returns the report type from the embedded filters, making the
// record event a models.ReportConfigOwner.
func (m *EphemeralRecordEvent) GetReportType() ReportType {
	return m.ReportType
}

// GetExpiresAt returns when the record expires, so an owned config can share
// its lifetime.
func (m *EphemeralRecordEvent) GetExpiresAt() time.Time {
	return m.ExpiresAt
}

// MakeEphemeralRecordEventKey creates a datastore NameKey from the ID
func MakeEphemeralRecordEventKey(id string) *datastore.Key {
	return datastore.NameKey(EphemeralRecordEventKind, id, nil)
}

type EphemeralStatus int

const (
	RunningStatus EphemeralStatus = iota
	CancelledStatus
	DoneStatus
	FailedStatus
	PendingStatus
)

func (es EphemeralStatus) String() string {
	return [...]string{"Running", "Cancelled", "Done", "Failed", "Pending"}[es]
}

func (es EphemeralStatus) MarshalText() ([]byte, error) {
	return []byte(es.String()), nil
}

func (es *EphemeralStatus) UnmarshalText(b []byte) error {
	*es = EphemeralStatusFromText(string(b))
	return nil
}

func EphemeralStatusFromText(text string) EphemeralStatus {
	switch strings.ToLower(text) {
	case "running":
		return RunningStatus
	case "cancelled":
		return CancelledStatus
	case "done":
		return DoneStatus
	case "failed":
		return FailedStatus
	case "pending":
		return PendingStatus
	default:
		return RunningStatus
	}
}

type ReportType string

const (
	KADSkillsProgress             ReportType = "KAD_SKILLS_PROGRESS"
	LearningPathsSkillsProgress   ReportType = "MAP_SKILLS_PROGRESS"
	LearningPathsOverallReportDI2 ReportType = "MAP_DI2"
	OverallReportDI2              ReportType = "OVERALL_DI2"
	MasteryStudent                ReportType = "MASTERY_STUDENT"
	MasteryClass                  ReportType = "MASTERY_CLASS"
	KhanmigoUsage                 ReportType = "KHANMIGO_USAGE"
	CourseChallengeSkills         ReportType = "COURSE_CHALLENGE_SKILLS"
	AssessmentPerformance         ReportType = "ASSESSMENT_PERFORMANCE"
)

type RollupType string

const (
	ClassroomRollup RollupType = "CLASSROOM"
	TeacherRollup   RollupType = "TEACHER"
	GradeRollup     RollupType = "GRADE"
	SchoolRollup    RollupType = "SCHOOL"
)
