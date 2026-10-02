package reports

import (
	"context"
	"reflect"
	"testing"
)

type fakeStore struct {
	Store
	assessmentRows [][]string
}

func (s fakeStore) AssessmentPerformanceRows(
	ctx context.Context,
	kaid string,
) ([][]string, error) {
	return s.assessmentRows, nil
}

func TestExportAssessmentPerformance(t *testing.T) {
	want := [][]string{{"student", "score"}, {"kaid_1", "87"}}
	store := fakeStore{assessmentRows: want}

	got, err := Export(context.Background(), "kaid_admin", AssessmentPerformance, store)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Export rows = %v, want %v", got, want)
	}
}
