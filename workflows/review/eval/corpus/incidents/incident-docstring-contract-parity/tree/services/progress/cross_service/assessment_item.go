package cross_service

// This file contains queries to the content service API.

import (
	"fmt"

	"github.com/Khan/webapp/pkg/content"
	"github.com/Khan/webapp/pkg/lib"
	"github.com/Khan/webapp/pkg/lib/cache"
	"github.com/Khan/webapp/pkg/lib/errors"
	"github.com/Khan/webapp/services/progress/generated/genqlient"
)

type AssessmentItem struct {
	ItemData string
}

type GqlAssessmentItemError = genqlient.Progress_AssessmentItemByIdAssessmentItemByIdAssessmentItemOrErrorErrorAssessmentItemError

// GetAssessmentItemJson is a request-cached function for fetching an
// assessments item's Perseus JSON (ie. ItemData) from the content service.
// This function can also be used as a proxy for checking if the assessment
// item exists.
var GetAssessmentItemJson = cache.Cache(
	_uncachedGetAssessmentItem,
	cache.In(lib.RequestCache),
	cache.SkipCacheOnError,
	cache.KeyParamsFxn(
		func(ctx CacheableContentRequestContext, exerciseID string, itemID string) string {
			kaLocale := content.GetRequestKALocale(ctx)
			publishedContentVersion, _ := content.GetRequestPublishedContentVersion(ctx)
			return fmt.Sprintf("%s/%s/%s/%s", kaLocale, publishedContentVersion, exerciseID, itemID)
		},
	),
)

// _uncachedGetAssessmentItem fetches an assessment item from the content
// service.
func _uncachedGetAssessmentItem(
	ctx CacheableContentRequestContext,
	exerciseId string,
	itemId string,
) (string, error) {
	_ = `# @genqlient
		query Progress_AssessmentItemById($exerciseId: ID!, $itemId: ID!) {
			assessmentItemById(exerciseId: $exerciseId, itemId: $itemId) {
				item {
					itemData
				}
				# @genqlient(pointer: true)
				error {
					code
					debugMessage
				}
			}
        }
	`

	resp, err := genqlient.Progress_AssessmentItemById(
		ctx,
		ctx.GraphQL().WithService("content").AsServiceAdmin(),
		exerciseId,
		itemId,
	)
	if err != nil {
		return "", errors.Wrap(err,
			"itemId", itemId,
			"exerciseId", exerciseId,
		)
	}

	assessmentItemError := resp.AssessmentItemById.Error
	if assessmentItemError != nil {
		return "", errors.Wrap(
			mapAssessmentItemErrorToError(assessmentItemError),
			"itemId", itemId,
			"exerciseId", exerciseId,
		)
	}

	return resp.AssessmentItemById.Item.ItemData, nil
}

func mapAssessmentItemErrorToError(
	assessmentItemError *GqlAssessmentItemError,
) error {
	//exhaustive:enforce
	switch assessmentItemError.Code {
	case genqlient.AssessmentItemErrorCodeNotFound,
		genqlient.AssessmentItemErrorCodeEmptyExercise,
		genqlient.AssessmentItemErrorCodeNoAccessibleItems:
		return errors.NotFound(assessmentItemError.DebugMessage)
	case genqlient.AssessmentItemErrorCodeInvalidInput:
		return errors.InvalidInput(assessmentItemError.DebugMessage)
	case genqlient.AssessmentItemErrorCodeUnexpectedError:
		return errors.Internal(assessmentItemError.DebugMessage)
	default:
		return errors.Internal(
			"unexpected error code from assessmentItem GraphQL field",
			errors.Fields{"code": assessmentItemError.Code},
		)
	}
}
