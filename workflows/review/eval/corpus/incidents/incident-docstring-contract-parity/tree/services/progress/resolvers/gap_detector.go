package resolvers

// Gap Detector adaptive assessment resolvers.
//
// This file contains all GraphQL resolvers for the adaptive assessment
// (gap detector) feature, including:
// - CRUD operations for UserAdaptiveAssessment entities
// - Assessment flow (get next item, submit answers)
// - Adaptive item selection using blueprint-constrained CAT

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/Khan/webapp/genproto/go/services/districts"
	"github.com/Khan/webapp/pkg/analytics/events"
	"github.com/Khan/webapp/pkg/content"
	"github.com/Khan/webapp/pkg/gcloud/datastore"
	"github.com/Khan/webapp/pkg/gcloud/datastore/crud"
	"github.com/Khan/webapp/pkg/gcloud/secrets"
	"github.com/Khan/webapp/pkg/gcloud/tasks"
	"github.com/Khan/webapp/pkg/kacontext"
	"github.com/Khan/webapp/pkg/khan/acl"
	"github.com/Khan/webapp/pkg/khan/users"
	"github.com/Khan/webapp/pkg/lib/errors"
	"github.com/Khan/webapp/pkg/lib/generic"
	"github.com/Khan/webapp/pkg/lib/httpctx"
	"github.com/Khan/webapp/pkg/lib/log"
	"github.com/Khan/webapp/pkg/lib/service_discovery"
	"github.com/Khan/webapp/pkg/lib/timectx"
	"github.com/Khan/webapp/pkg/services_shared/perseus_client"
	"github.com/Khan/webapp/pkg/web"
	"github.com/Khan/webapp/pkg/web/gqlclient"
	"github.com/Khan/webapp/services/progress/adaptive_test"
	"github.com/Khan/webapp/services/progress/cross_service"
	"github.com/Khan/webapp/services/progress/generated/analytics_events"
	"github.com/Khan/webapp/services/progress/generated/automap"
	"github.com/Khan/webapp/services/progress/generated/capabilities"
	"github.com/Khan/webapp/services/progress/generated/graphql"
	"github.com/Khan/webapp/services/progress/models"
)

// SelectFromTopN controls item selection randomization in production.
// Items are selected randomly from the top N highest Fisher Information items
// to reduce item exposure while maintaining adaptive efficiency.
const SelectFromTopN = 3

// GetUserAdaptiveAssessments retrieves all UserAdaptiveAssessment entities for
// service admin use
func (r *queryResolver) GetUserAdaptiveAssessments(
	ctx context.Context,
) ([]*graphql.UserAdaptiveAssessment, error) {
	var ktx interface {
		log.KAContext
		datastore.KAContext
		gqlclient.KAContext
		web.AuthedUserContext
	} = kacontext.Upgrade(ctx)

	adminPermissions := acl.ActorHasPermission(
		ktx,
		capabilities.CanDoWhatOnlyAdminsCanDo,
		acl.GlobalScope,
	)

	if !adminPermissions {
		return nil, errors.Unauthorized()
	}

	// Fetch all assessments from datastore
	assessments, err := adaptive_test.GetAllUserAdaptiveAssessments(ktx)
	if err != nil {
		return nil, errors.Wrap(err)
	}

	// Convert to GraphQL types
	result := make([]*graphql.UserAdaptiveAssessment, len(assessments))
	for i, assessment := range assessments {
		responses := make([]*graphql.StudentResponse, len(assessment.Responses))
		for j := range assessment.Responses {
			response := &assessment.Responses[j]
			score := &response.Score
			responses[j] = &graphql.StudentResponse{
				ItemID:             response.ItemID,
				Score:              score,
				CreatedAt:          response.CreatedAt,
				UserAnswer:         response.UserAnswer,
				Theta:              response.Theta,
				ThetaStandardError: response.ThetaStandardError,
				Weights:            response.Weights,
			}
		}

		result[i] = &graphql.UserAdaptiveAssessment{
			UserKaid:      assessment.UserKAID,
			BlueprintID:   int(assessment.BlueprintID),
			CreatedAt:     assessment.CreatedAt,
			Responses:     responses,
			CurrentItemID: assessment.CurrentItemID,
		}
	}

	return result, nil
}

// GetUserAdaptiveAssessment retrieves a specific UserAdaptiveAssessment by user
// KAID. Used by admins to get a user's assigned assessment
func (r *queryResolver) GetUserAdaptiveAssessment(
	ctx context.Context,
	userKaid string,
) (*graphql.UserAdaptiveAssessment, error) {
	var ktx interface {
		log.KAContext
		datastore.KAContext
		gqlclient.KAContext
		web.AuthedUserContext
	} = kacontext.Upgrade(ctx)

	adminPermissions := acl.ActorHasPermission(
		ktx,
		capabilities.CanDoWhatOnlyAdminsCanDo,
		acl.GlobalScope,
	)

	if !adminPermissions {
		return nil, errors.Unauthorized()
	}

	// Fetch the latest assessment from datastore
	assessment, err := adaptive_test.GetLatestUserAdaptiveAssessment(
		ktx,
		userKaid,
	)
	if err != nil {
		if errors.Is(err, adaptive_test.AssessmentNotFoundError) {
			return nil, nil // Return nil for not found (GraphQL nullable field)
		}
		return nil, errors.Wrap(err)
	}

	// Convert responses to GraphQL types
	responses := make([]*graphql.StudentResponse, len(assessment.Responses))
	for i := range assessment.Responses {
		response := &assessment.Responses[i]
		score := &response.Score
		responses[i] = &graphql.StudentResponse{
			ItemID:             response.ItemID,
			Score:              score,
			CreatedAt:          response.CreatedAt,
			UserAnswer:         response.UserAnswer,
			Theta:              response.Theta,
			ThetaStandardError: response.ThetaStandardError,
			Weights:            response.Weights,
		}
	}

	return &graphql.UserAdaptiveAssessment{
		UserKaid:      assessment.UserKAID,
		BlueprintID:   int(assessment.BlueprintID),
		CreatedAt:     assessment.CreatedAt,
		Responses:     responses,
		CurrentItemID: assessment.CurrentItemID,
	}, nil
}

// CreateUserAdaptiveAssessment creates a new UserAdaptiveAssessment for the
// given user
func (r *mutationResolver) CreateUserAdaptiveAssessment(
	ctx context.Context,
	userKaid string,
	blueprintID *int,
) (*graphql.CreateUserAdaptiveAssessmentMutationResult, error) {
	var ktx interface {
		kacontext.Base
		log.KAContext
		datastore.KAContext
		gqlclient.KAContext
		web.AuthedUserContext
		timectx.KAContext
	} = kacontext.Upgrade(ctx)

	adminPermissions := acl.ActorHasPermission(
		ktx,
		capabilities.CanDoWhatOnlyAdminsCanDo,
		acl.GlobalScope,
	)

	if !adminPermissions {
		return automap.CreateUserAdaptiveAssessmentMutationResultErr(
			ktx,
			errors.Unauthorized(),
		)
	}

	// Check that user exists
	userExists, _ := users.Exists(ktx, userKaid)
	if !userExists {
		return automap.CreateUserAdaptiveAssessmentMutationResultErr(
			ktx,
			adaptive_test.UserNotFoundError,
		)
	}

	var blueprint *models.Blueprint
	var err error

	// Use provided blueprintID if given, otherwise get by student grade
	if blueprintID != nil {
		blueprint, err = adaptive_test.GetBlueprint(ktx, int64(*blueprintID))
		if err != nil {
			return automap.CreateUserAdaptiveAssessmentMutationResultErr(
				ktx,
				errors.Wrap(err, "failed to get blueprint by ID", log.Fields{
					"blueprintID": *blueprintID,
				}),
			)
		}
	} else {
		// Get student's grade from districts data
		studentGrade, err := _getStudentGrade(ktx, userKaid)
		if err != nil {
			return automap.CreateUserAdaptiveAssessmentMutationResultErr(
				ktx,
				errors.Wrap(err),
			)
		}

		blueprint, err = adaptive_test.GetBlueprintByGrade(ktx, studentGrade)
		if err != nil {
			return automap.CreateUserAdaptiveAssessmentMutationResultErr(
				ktx,
				errors.Wrap(err, "failed to get blueprint for grade", log.Fields{
					"grade": studentGrade,
				}),
			)
		}
	}

	// Create new assessment with the blueprint ID
	blueprintIDVal := blueprint.Key.ID
	assessment := models.NewUserAdaptiveAssessment(userKaid, blueprintIDVal)

	// Create blueprint manager for this request
	items, blueprintConfig, exerciseMap, err := adaptive_test.GetItemBank(ktx, blueprintIDVal)
	if err != nil {
		return automap.CreateUserAdaptiveAssessmentMutationResultErr(ktx, err)
	}
	manager := adaptive_test.NewBlueprintManager(items, blueprintConfig, exerciseMap)

	// Set initial CurrentItemID using the same blueprint logic. This ensures
	// assessment is never in a state where CurrentItemID is nil
	firstItemID, err := manager.SelectNextItem(
		ktx,
		adaptive_test.ToResponses(assessment.Responses),
		0.0, // Initial theta estimate
	)
	if err != nil || firstItemID == "" {
		return automap.CreateUserAdaptiveAssessmentMutationResultErr(
			ktx,
			adaptive_test.ItemSelectionFailedError,
		)
	}
	assessment.CurrentItemID = &firstItemID

	ktx.Log().Info("Selected initial assessment item", log.Fields{
		"userKaid":    userKaid,
		"firstItemID": firstItemID,
	})

	// Save to datastore
	err = adaptive_test.PutUserAdaptiveAssessment(ktx, assessment)
	if err != nil {
		return automap.CreateUserAdaptiveAssessmentMutationResultErr(ktx, errors.Wrap(err))
	}

	ktx.Log().Info("Created new UserAdaptiveAssessment", log.Fields{
		"userKaid": userKaid,
	})

	// Convert to GraphQL type and return success
	return &graphql.CreateUserAdaptiveAssessmentMutationResult{
		Assessment: &graphql.UserAdaptiveAssessment{
			UserKaid:      assessment.UserKAID,
			BlueprintID:   int(assessment.BlueprintID),
			CreatedAt:     assessment.CreatedAt,
			Responses:     []*graphql.StudentResponse{},
			CurrentItemID: assessment.CurrentItemID,
		},
	}, nil
}

// CreateUserAdaptiveAssessmentBatch creates UserAdaptiveAssessments for
// multiple users by enqueueing tasks for each user. Returns immediately after
// enqueueing all tasks.
func (r *mutationResolver) CreateUserAdaptiveAssessmentBatch(
	ctx context.Context,
	userKaids []string,
	blueprintID *int,
) (*graphql.CreateUserAdaptiveAssessmentBatchResult, error) {
	var ktx interface {
		kacontext.Base
		log.KAContext
		datastore.KAContext
		tasks.KAContext
		gqlclient.KAContext
		web.AuthedUserContext
	} = kacontext.Upgrade(ctx)

	// Check admin permissions
	adminPermissions := acl.ActorHasPermission(
		ktx,
		capabilities.CanDoWhatOnlyAdminsCanDo,
		acl.GlobalScope,
	)

	if !adminPermissions {
		return &graphql.CreateUserAdaptiveAssessmentBatchResult{
			Error: &graphql.CreateUserAdaptiveAssessmentBatchError{
				Message: "Unauthorized",
				Code:    graphql.CreateUserAdaptiveAssessmentBatchErrorCodeUnauthorized,
			},
			EnqueuedCount:   0,
			FailedUserKaids: []string{},
		}, nil
	}

	// Validate blueprint if provided
	if blueprintID != nil {
		_, err := adaptive_test.GetBlueprint(ktx, int64(*blueprintID))
		if err != nil {
			return &graphql.CreateUserAdaptiveAssessmentBatchResult{
				Error: &graphql.CreateUserAdaptiveAssessmentBatchError{
					Message: "Blueprint not found",
					Code:    graphql.CreateUserAdaptiveAssessmentBatchErrorCodeInternalError,
				},
				EnqueuedCount:   0,
				FailedUserKaids: []string{},
			}, nil
		}
	}

	// Enqueue tasks for each user
	enqueuedCount := 0
	failedUserKaids := []string{}

	for _, userKaid := range userKaids {
		err := cross_service.CreateUserAdaptiveAssessmentInTask(ktx, userKaid, blueprintID)
		if err != nil {
			ktx.Log().Error(errors.Wrap(err, "userKaid", userKaid))
			failedUserKaids = append(failedUserKaids, userKaid)
		} else {
			enqueuedCount++
		}
	}

	ktx.Log().Info("Enqueued batch adaptive assessment tasks", log.Fields{
		"totalRequested": len(userKaids),
		"enqueuedCount":  enqueuedCount,
		"failedCount":    len(failedUserKaids),
		"blueprintID":    blueprintID,
	})

	return &graphql.CreateUserAdaptiveAssessmentBatchResult{
		Error:           nil,
		EnqueuedCount:   enqueuedCount,
		FailedUserKaids: failedUserKaids,
	}, nil
}

// loadAssessmentContext extracts common setup logic for assessment resolvers:
// gets user, loads assessment, and creates blueprint manager
func loadAssessmentContext(
	ctx interface {
		datastore.KAContext
		kacontext.Base
		web.AuthedUserContext
	},
) (
	userKAID string,
	assessment *models.UserAdaptiveAssessment,
	manager *adaptive_test.BlueprintManager,
	err error,
) {
	// Get the current user
	currentUser, err := ctx.RequestUser()
	if err != nil {
		return "", nil, nil, err
	}
	userKAID = currentUser.Kaid

	// Get the user's latest assessment
	assessment, err = adaptive_test.GetLatestUserAdaptiveAssessment(ctx, userKAID)
	if err != nil {
		return "", nil, nil, err
	}

	// Create blueprint manager for this request
	items, blueprint, exerciseMap, err := adaptive_test.GetItemBank(ctx, assessment.BlueprintID)
	if err != nil {
		return "", nil, nil, err
	}
	manager = adaptive_test.NewBlueprintManager(items, blueprint, exerciseMap)

	return userKAID, assessment, manager, nil
}

// fetchAssessmentItemJson looks up exercise mapping and fetches the assessment
// item JSON complete with answers
func fetchAssessmentItemJson(
	ctx interface {
		gqlclient.KAContext
		log.KAContext
		web.KALocaleContext
		web.PublishedContentVersionContext
	},
	manager *adaptive_test.BlueprintManager,
	itemID string,
) (string, error) {
	// Get exercise ID for item
	exerciseID, exists := adaptive_test.GetExerciseIDForItem(manager, itemID)
	if !exists {
		return "", errors.Internal("no exercise mapping found for item",
			errors.Fields{
				"exerciseID": exerciseID,
				"itemID":     itemID,
			},
		)
	}

	// Fetch the assessment item from content service (includes answers)
	assessmentItemJson, err := cross_service.GetAssessmentItemJson(
		ctx,
		exerciseID,
		itemID,
	)
	if err != nil {
		return "", errors.Wrap(err, "exerciseID", exerciseID, "itemID", itemID)
	}

	return assessmentItemJson, nil
}

// scoreAnswer scores an assessment item answer and returns the score as float64
func scoreAnswer(
	ctx interface {
		context.Context
		service_discovery.KAContext
		secrets.KAContext
		httpctx.KAContext
		web.ServiceVersionContext
		web.KALocaleContext
	},
	itemData string,
	userAnswer string,
) (float64, error) {
	score, err := cross_service.ScoreItemWithPerseus(
		ctx,
		itemData,
		userAnswer,
		content.GetRequestKALocale(ctx),
	)
	if err != nil {
		return 0.0, errors.Wrap(err,
			"itemData", itemData,
			"userAnswer", userAnswer,
		)
	}

	// Convert Perseus score string to float64
	if score.Status() == perseus_client.ScoreStatusCorrect {
		return 1.0, nil
	}
	return 0.0, nil
}

func (r *queryResolver) GetNextAssessmentItem(
	ctx context.Context,
) (*graphql.NextAssessmentItemResponse, error) {
	// Extract context interfaces
	var ktx interface {
		datastore.KAContext
		events.PublishEventContext
		gqlclient.KAContext
		kacontext.Base
		log.KAContext
		timectx.KAContext
		web.AuthedUserContext
		web.KALocaleContext
		web.PublishedContentVersionContext
	} = kacontext.Upgrade(ctx)

	// Authorization: Access is controlled in two ways: 1. Only admins can
	// create UserAdaptiveAssessments (via gated mutation) 2. Students can
	// only access their own assessment using their authenticated
	//    KAID from the request context (fails if no assessment exists)
	acl.OpenAccess()

	// Load assessment context
	userKAID, assessment, manager, err := loadAssessmentContext(ktx)
	if err != nil {
		return automap.NextAssessmentItemResponseErr(ktx, err)
	}

	// Check if assessment is complete using proper completion criteria
	if assessment.CurrentItemID == nil {
		ktx.Log().Info("Assessment is complete - no more items available", log.Fields{
			"userKAID":       userKAID,
			"BlueprintID":    assessment.BlueprintID,
			"responsesCount": len(assessment.Responses),
		})

		// Return response indicating assessment is complete
		response := &graphql.NextAssessmentItemResponse{
			Item:         nil,                       // No item when complete
			CurrentIndex: len(assessment.Responses), // Index of completed responses
			TotalItems:   adaptive_test.BlueprintTotalItems(ktx, manager),
			IsComplete:   true, // Assessment is complete
		}
		return response, nil
	}

	currentItemID := *assessment.CurrentItemID

	// Fetch the assessment item
	assessmentItemJson, err := fetchAssessmentItemJson(ktx, manager, currentItemID)
	if err != nil {
		return automap.NextAssessmentItemResponseErr(ktx, err)
	}

	// Convert to SimpleAssessmentItem format
	simpleItem := &graphql.SimpleAssessmentItem{
		ID:      currentItemID,
		Content: assessmentItemJson,
	}

	// Publish CEDAR event for item viewed
	analytics_events.PublishGapDetectorItemViewedTIV1(
		ktx,
		userKAID,
		strconv.FormatInt(assessment.BlueprintID, 10),
		assessment.Key.Name,
		currentItemID,
		ktx.Time().Now(),
		int64(len(assessment.Responses)),
	)

	// Build the response
	response := &graphql.NextAssessmentItemResponse{
		Item:         simpleItem,
		CurrentIndex: len(assessment.Responses) + 1, // Current item number (1-based: completed + 1)
		TotalItems:   adaptive_test.BlueprintTotalItems(ktx, manager),
		IsComplete:   false,
	}

	return response, nil
}

func (r *mutationResolver) SubmitAssessmentAnswer(
	ctx context.Context,
	userAnswer string,
) (*graphql.SubmitAssessmentItemResponse, error) {
	// Extract context interfaces
	var ktx interface {
		datastore.KAContext
		events.PublishEventContext
		gqlclient.KAContext
		httpctx.KAContext
		kacontext.Base
		log.KAContext
		secrets.KAContext
		service_discovery.KAContext
		timectx.KAContext
		web.AuthedUserContext
		web.KALocaleContext
		web.PublishedContentVersionContext
		web.ServiceVersionContext
	} = kacontext.Upgrade(ctx)

	// Authorization: Access is controlled in two ways: 1. Only admins can
	// create UserAdaptiveAssessments (via gated mutation) 2. Students can
	// only access their own assessment using their authenticated
	//    KAID from the request context (fails if no assessment exists)
	acl.OpenAccess()

	// Load assessment context
	_, latestAssessment, manager, err := loadAssessmentContext(ktx)
	if err != nil {
		return automap.SubmitAssessmentItemResponseErr(ktx, err)
	}

	var responseScore *int
	var isComplete bool
	var numCorrect *int

	// Perform the entire assessment update within a transaction
	err = crud.Update(
		ktx,
		latestAssessment.Key,
		func(assessment *models.UserAdaptiveAssessment) error {
			// Re-initialize variables modified from outer scope
			responseScore = nil
			isComplete = false
			numCorrect = nil

			// Check if the assessment is already complete
			if assessment.CurrentItemID == nil {
				return adaptive_test.AssessmentAlreadyCompleteError
			}

			currentItemID := *assessment.CurrentItemID

			// Fetch the assessment item (includes answers for scoring)
			assessmentItemJson, err := fetchAssessmentItemJson(ktx, manager, currentItemID)
			if err != nil {
				return err
			}

			// Score the user's answer
			scoreValue, err := scoreAnswer(
				ktx,
				assessmentItemJson,
				userAnswer,
			)
			if err != nil {
				return err
			}

			// Build responses slice including the new response
			newResponse := adaptive_test.Response{
				ItemID: currentItemID,
				Score:  scoreValue,
			}
			allResponses := append(
				adaptive_test.ToResponses(assessment.Responses),
				newResponse,
			)

			// Calculate theta, SE, and weights for all responses
			theta, thetaSE, weights, err := manager.CalculateAbility(allResponses, 0.0)
			if err != nil {
				return errors.Wrap(err)
			}

			// Capture the timestamp for both the response and the CEDAR
			// event This ensures consistency between the event and the
			// stored response
			answeredAt := ktx.Time().Now()

			// Add the response with all calculated values
			assessment.AddResponse(
				currentItemID,
				scoreValue,
				userAnswer,
				theta,
				thetaSE,
				weights,
			)
			// Set CreatedAt explicitly on the last response so it matches
			// what we send to CEDAR
			latestResponse := &assessment.Responses[len(assessment.Responses)-1]
			latestResponse.CreatedAt = answeredAt

			// Convert weights to JSON string for CEDAR event
			weightsJSON, err := json.Marshal(weights)
			if err != nil {
				return errors.Wrap(err)
			}

			// Publish CEDAR event for item answered
			analytics_events.PublishGapDetectorItemAnsweredTIV1(
				ktx,
				assessment.UserKAID,
				scoreValue == 1.0,
				strconv.FormatInt(assessment.BlueprintID, 10),
				assessment.Key.Name,
				currentItemID,
				latestResponse.UserAnswer,
				answeredAt,
				theta,
				thetaSE,
				string(weightsJSON),
				int64(len(assessment.Responses)),
			)

			// Use blueprint to select next item based on current assessment
			// state
			nextItemID, err := manager.SelectNextItem(
				ktx,
				allResponses, // Reuse the responses we already built
				0.0,          // Initial theta estimate
			)
			switch {
			case err != nil:
				return err
			case nextItemID == "":
				// max items reached
				assessment.CurrentItemID = nil
			default:
				// Update the assessment with the next item
				assessment.CurrentItemID = &nextItemID
			}

			// Capture values before transaction completes to avoid extra
			// datastore read
			responseScore = generic.Pointer(int(scoreValue))
			isComplete = assessment.CurrentItemID == nil

			// Only calculate completion stats when assessment is complete
			if isComplete {
				correctCount := 0
				for i := range assessment.Responses {
					if assessment.Responses[i].Score == 1.0 {
						correctCount++
					}
				}
				numCorrect = &correctCount
			}

			return nil
		},
	)
	if err != nil {
		return automap.SubmitAssessmentItemResponseErr(ktx, err)
	}

	response := &graphql.SubmitAssessmentItemResponse{
		TotalItems: adaptive_test.BlueprintTotalItems(ktx, manager),
		IsComplete: isComplete,
		Score:      responseScore,
		NumCorrect: numCorrect,
	}

	return response, nil
}

// _getStudentGrade retrieves the student's grade level from districts data.
// Returns the grade as an integer (e.g., 6 for "SIXTH").
// Returns an error if no district grade level data is found.
func _getStudentGrade(
	ctx interface {
		log.KAContext
		gqlclient.KAContext
	},
	userKaid string,
) (int, error) {
	// Query districts for student's grade level
	districtInfo, err := cross_service.GetDistrictSchoolGradeForStudent(ctx, userKaid)
	if err != nil {
		return 0, errors.Wrap(err)
	}

	// Require district grade level data
	if len(districtInfo) == 0 || districtInfo[0].GradeLevel == "" {
		return 0, errors.InvalidInput(
			"user must have district grade level data to assign grade-based blueprint",
			log.Fields{
				"userKaid": userKaid,
			},
		)
	}

	gradeLevel := districtInfo[0].GradeLevel

	// Parse grade level string
	grade, err := _parseGradeLevel(gradeLevel)
	if err != nil {
		return 0, err
	}

	return grade, nil
}

// _parseGradeLevel parses a grade level string (e.g., "SIXTH", "THIRD")
// and returns the numeric grade value using the protobuf enum mapping.
func _parseGradeLevel(gradeLevel string) (int, error) {
	if gradeLevel == "" {
		return 0, errors.InvalidInput("invalid grade level format: empty string")
	}

	// Use the protobuf enum map to convert grade level string to numeric value
	gradeValue, ok := districts.DistrictGradeLevel_value[gradeLevel]
	if !ok {
		return 0, errors.InvalidInput("unknown grade level", log.Fields{
			"gradeLevel": gradeLevel,
		})
	}

	// Convert to int and return
	return int(gradeValue), nil
}

// GetBlueprints retrieves all available blueprints for admin blueprint
// selection
func (r *queryResolver) GetBlueprints(
	ctx context.Context,
) ([]*graphql.BlueprintInfo, error) {
	var ktx interface {
		context.Context
		log.KAContext
		datastore.KAContext
		gqlclient.KAContext
		web.AuthedUserContext
	} = kacontext.Upgrade(ctx)

	adminPermissions := acl.ActorHasPermission(
		ktx,
		capabilities.CanDoWhatOnlyAdminsCanDo,
		acl.GlobalScope,
	)

	if !adminPermissions {
		return nil, errors.Unauthorized()
	}

	// Fetch all blueprints from datastore
	blueprints, err := adaptive_test.GetAllBlueprints(ktx)
	if err != nil {
		return nil, errors.Wrap(err)
	}

	// Convert to GraphQL BlueprintInfo types
	result := make([]*graphql.BlueprintInfo, len(blueprints))
	for i, blueprint := range blueprints {
		result[i] = &graphql.BlueprintInfo{
			ID:         int(blueprint.Key.ID),
			GradeLevel: blueprint.GradeLevel,
		}
	}

	return result, nil
}
