package resolvers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/Khan/webapp/dev/gqltest"
	"github.com/Khan/webapp/dev/servicetest"
	"github.com/Khan/webapp/pkg/gcloud/tasks/taskstest"
	"github.com/Khan/webapp/pkg/khan/acl"
	"github.com/Khan/webapp/pkg/khan/users"
	"github.com/Khan/webapp/pkg/lib/errors"
	"github.com/Khan/webapp/pkg/web/gqlclient"
	"github.com/Khan/webapp/pkg/web/gqlclient/js"
	"github.com/Khan/webapp/services/progress/adaptive_test"
	"github.com/Khan/webapp/services/progress/cross_service"
	"github.com/Khan/webapp/services/progress/generated/analytics_events"
	"github.com/Khan/webapp/services/progress/generated/capabilities"
	"github.com/Khan/webapp/services/progress/generated/graphql"
	"github.com/Khan/webapp/services/progress/models"
)

type gapDetectorSuite struct {
	servicetest.Suite
}

func (suite *gapDetectorSuite) TestGetBlueprints() {
	ctx := suite.KAContext().Clone()
	ctx.RequestData.User.HasAnyPermissions = true

	// Mock admin permissions
	mux := gqlclient.NewMux()
	acl.MockActorPermissions(mux, ctx.User, []acl.MockPermission{
		{Capability: capabilities.CanDoWhatOnlyAdminsCanDo, Scope: acl.MockGlobalScope},
	})
	ctx.GraphQLClient = gqlclient.NewMockClient(mux)

	// Create test blueprints with different grade levels
	blueprint3 := models.NewBlueprint(3)
	key3, err := adaptive_test.PutBlueprint(ctx, blueprint3)
	suite.Require().NoError(err)

	blueprint5 := models.NewBlueprint(5)
	key5, err := adaptive_test.PutBlueprint(ctx, blueprint5)
	suite.Require().NoError(err)

	blueprint9000 := models.NewBlueprint(9000)
	key9000, err := adaptive_test.PutBlueprint(ctx, blueprint9000)
	suite.Require().NoError(err)

	// Build GraphQL client
	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	query := `
		query Test_GetBlueprints {
			getBlueprints {
				id
				gradeLevel
			}
		}
	`

	// Execute query through GraphQL
	resp, err := gqltest.Query(ctx, client.AsUser(), query, js.Obj{})
	suite.Require().NoError(err)
	suite.Require().NotNil(resp)

	// Verify response
	blueprintsRaw, ok := resp["getBlueprints"].([]interface{})
	suite.Require().True(ok, "Should have getBlueprints field")
	suite.Require().GreaterOrEqual(len(blueprintsRaw), 3, "Should have at least 3 blueprints")

	// Convert to map for easier verification
	blueprintMap := make(map[int]map[string]interface{})
	for _, bp := range blueprintsRaw {
		bpMap := bp.(map[string]interface{})
		id := int(bpMap["id"].(float64))
		blueprintMap[id] = bpMap
	}

	// Verify grade 3 blueprint
	bp3 := blueprintMap[int(key3.ID)]
	suite.Require().NotNil(bp3, "Grade 3 blueprint should be in results")
	suite.Require().Equal(3, int(bp3["gradeLevel"].(float64)))

	// Verify grade 5 blueprint
	bp5 := blueprintMap[int(key5.ID)]
	suite.Require().NotNil(bp5, "Grade 5 blueprint should be in results")
	suite.Require().Equal(5, int(bp5["gradeLevel"].(float64)))

	// Verify grade 9000 blueprint (test blueprint)
	bp9000 := blueprintMap[int(key9000.ID)]
	suite.Require().NotNil(bp9000, "Grade 9000 blueprint should be in results")
	suite.Require().Equal(9000, int(bp9000["gradeLevel"].(float64)))
}

func (suite *gapDetectorSuite) TestGetUserAdaptiveAssessments() {
	ctx := suite.KAContext().Clone()
	ctx.RequestData.User.HasAnyPermissions = true

	// Mock admin permissions
	mux := gqlclient.NewMux()
	acl.MockActorPermissions(mux, ctx.User, []acl.MockPermission{
		{Capability: capabilities.CanDoWhatOnlyAdminsCanDo, Scope: acl.MockGlobalScope},
	})
	ctx.GraphQLClient = gqlclient.NewMockClient(mux)

	// Create test assessment data
	userKAID1 := "kaid_test_user_1"
	userKAID2 := "kaid_test_user_2"

	// Create manager for ability calculations
	items, blueprint, exerciseMap, err := adaptive_test.GetItemBank(ctx, 0)
	suite.Require().NoError(err)
	manager := adaptive_test.NewBlueprintManager(items, blueprint, exerciseMap)

	// Create first assessment with responses
	assessment1 := models.NewUserAdaptiveAssessment(userKAID1, 1)
	newResp1 := adaptive_test.Response{ItemID: "xe969f1c2bda72ec0", Score: 1.0}
	allResp1 := append(adaptive_test.ToResponses(assessment1.Responses), newResp1)
	theta1, se1, weights1, err := manager.CalculateAbility(allResp1, 0.0)
	suite.Require().NoError(err)
	assessment1.AddResponse("xe969f1c2bda72ec0", 1.0, "test-answer", theta1, se1, weights1)

	newResp2 := adaptive_test.Response{ItemID: "x147aad123a743f14", Score: 0.0}
	allResp2 := append(adaptive_test.ToResponses(assessment1.Responses), newResp2)
	theta2, se2, weights2, err := manager.CalculateAbility(allResp2, 0.0)
	suite.Require().NoError(err)
	assessment1.AddResponse("x147aad123a743f14", 0.0, "test-answer", theta2, se2, weights2)
	currentItemID1 := "xf81acc1058c5dbcc"
	assessment1.CurrentItemID = &currentItemID1
	err = adaptive_test.PutUserAdaptiveAssessment(ctx, assessment1)
	suite.Require().NoError(err)

	// Create second assessment with different responses
	assessment2 := models.NewUserAdaptiveAssessment(userKAID2, 1)
	newRespA := adaptive_test.Response{ItemID: "xe969f1c2bda72ec0", Score: 0.5}
	allRespA := append(adaptive_test.ToResponses(assessment2.Responses), newRespA)
	thetaA, seA, weightsA, err := manager.CalculateAbility(allRespA, 0.0)
	suite.Require().NoError(err)
	assessment2.AddResponse("xe969f1c2bda72ec0", 0.5, "test-answer", thetaA, seA, weightsA)
	currentItemID2 := "x147aad123a743f14"
	assessment2.CurrentItemID = &currentItemID2
	err = adaptive_test.PutUserAdaptiveAssessment(ctx, assessment2)
	suite.Require().NoError(err)

	// Build GraphQL client
	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	query := `
		query Test_GetUserAdaptiveAssessments {
			getUserAdaptiveAssessments {
				userKAID
				blueprintID
				currentItemID
				responses {
					itemID
					score
				}
			}
		}
	`

	// Execute query through GraphQL
	resp, err := gqltest.Query(ctx, client.AsUser(), query, js.Obj{})
	suite.Require().NoError(err)
	suite.Require().NotNil(resp)

	// Verify response
	assessmentsRaw, ok := resp["getUserAdaptiveAssessments"].([]interface{})
	suite.Require().True(ok, "Should have getUserAdaptiveAssessments field")
	suite.Require().Len(assessmentsRaw, 2, "Should have 2 assessments")

	// Convert to map for easier verification (order may vary)
	assessmentMap := make(map[string]map[string]interface{})
	for _, a := range assessmentsRaw {
		aMap := a.(map[string]interface{})
		userKaid := aMap["userKAID"].(string)
		assessmentMap[userKaid] = aMap
	}

	// Verify first assessment
	assessment1Result := assessmentMap[userKAID1]
	suite.Require().NotNil(assessment1Result)
	suite.Require().Equal(userKAID1, assessment1Result["userKAID"])
	suite.Require().Equal("xf81acc1058c5dbcc", assessment1Result["currentItemID"])

	responses1 := assessment1Result["responses"].([]interface{})
	suite.Require().Len(responses1, 2)
	resp1_0 := responses1[0].(map[string]interface{})
	suite.Require().Equal("xe969f1c2bda72ec0", resp1_0["itemID"])
	suite.Require().Equal(1.0, resp1_0["score"])
	resp1_1 := responses1[1].(map[string]interface{})
	suite.Require().Equal("x147aad123a743f14", resp1_1["itemID"])
	suite.Require().Equal(0.0, resp1_1["score"])

	// Verify second assessment
	assessment2Result := assessmentMap[userKAID2]
	suite.Require().NotNil(assessment2Result)
	suite.Require().Equal(userKAID2, assessment2Result["userKAID"])
	suite.Require().Equal("x147aad123a743f14", assessment2Result["currentItemID"])

	responses2 := assessment2Result["responses"].([]interface{})
	suite.Require().Len(responses2, 1)
	resp2_0 := responses2[0].(map[string]interface{})
	suite.Require().Equal("xe969f1c2bda72ec0", resp2_0["itemID"])
	suite.Require().Equal(0.5, resp2_0["score"])
}

func (suite *gapDetectorSuite) TestGetUserAdaptiveAssessment() {
	ctx := suite.KAContext().Clone()
	ctx.RequestData.User.HasAnyPermissions = true

	// Mock admin permissions
	mux := gqlclient.NewMux()
	acl.MockActorPermissions(mux, ctx.User, []acl.MockPermission{
		{Capability: capabilities.CanDoWhatOnlyAdminsCanDo, Scope: acl.MockGlobalScope},
	})
	ctx.GraphQLClient = gqlclient.NewMockClient(mux)

	// Create test assessment
	userKAID := "kaid_test_user"

	// Create manager for ability calculations
	items, blueprint, exerciseMap, err := adaptive_test.GetItemBank(ctx, 0)
	suite.Require().NoError(err)
	manager := adaptive_test.NewBlueprintManager(items, blueprint, exerciseMap)

	assessment := models.NewUserAdaptiveAssessment(userKAID, 1)
	newResp1 := adaptive_test.Response{ItemID: "xe969f1c2bda72ec0", Score: 1.0}
	allResp1 := append(adaptive_test.ToResponses(assessment.Responses), newResp1)
	theta1, se1, weights1, err := manager.CalculateAbility(allResp1, 0.0)
	suite.Require().NoError(err)
	assessment.AddResponse("xe969f1c2bda72ec0", 1.0, "test-answer", theta1, se1, weights1)

	newResp2 := adaptive_test.Response{ItemID: "x147aad123a743f14", Score: 0.5}
	allResp2 := append(adaptive_test.ToResponses(assessment.Responses), newResp2)
	theta2, se2, weights2, err := manager.CalculateAbility(allResp2, 0.0)
	suite.Require().NoError(err)
	assessment.AddResponse("x147aad123a743f14", 0.5, "test-answer", theta2, se2, weights2)
	currentItemID := "xf81acc1058c5dbcc"
	assessment.CurrentItemID = &currentItemID
	err = adaptive_test.PutUserAdaptiveAssessment(ctx, assessment)
	suite.Require().NoError(err)

	// Build GraphQL client
	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	query := `
		query Test_GetUserAdaptiveAssessment($userKaid: String!) {
			getUserAdaptiveAssessment(userKaid: $userKaid) {
				userKAID
				blueprintID
				currentItemID
				responses {
					itemID
					score
				}
			}
		}
	`

	// Execute query through GraphQL
	resp, err := gqltest.Query(ctx, client.AsUser(), query, js.Obj{
		"userKaid": userKAID,
	})
	suite.Require().NoError(err)
	suite.Require().NotNil(resp)

	// Verify response
	assessmentRaw, ok := resp["getUserAdaptiveAssessment"].(map[string]interface{})
	suite.Require().True(ok, "Should have getUserAdaptiveAssessment field")
	suite.Require().Equal(userKAID, assessmentRaw["userKAID"])
	suite.Require().Equal("xf81acc1058c5dbcc", assessmentRaw["currentItemID"])

	responses := assessmentRaw["responses"].([]interface{})
	suite.Require().Len(responses, 2)

	resp0 := responses[0].(map[string]interface{})
	suite.Require().Equal("xe969f1c2bda72ec0", resp0["itemID"])
	suite.Require().Equal(1.0, resp0["score"])

	resp1 := responses[1].(map[string]interface{})
	suite.Require().Equal("x147aad123a743f14", resp1["itemID"])
	suite.Require().Equal(0.5, resp1["score"])
}

func (suite *gapDetectorSuite) TestCreateUserAdaptiveAssessment() {
	ctx := suite.KAContext().Clone()
	ctx.RequestData.User.HasAnyPermissions = true

	// Create a blueprint for grade 6 that the test will use
	blueprint := models.NewBlueprint(6)
	blueprintKey, err := adaptive_test.PutBlueprint(ctx, blueprint)
	suite.Require().NoError(err)
	suite.Require().NotNil(blueprintKey)

	// Mock admin permissions
	mux := gqlclient.NewMux()
	acl.MockActorPermissions(mux, ctx.User, []acl.MockPermission{
		{Capability: capabilities.CanDoWhatOnlyAdminsCanDo, Scope: acl.MockGlobalScope},
	})

	userKAID := "kaid_1235"

	// Mock districts data to return grade 6
	cross_service.MockGetDistrictSchoolGradeForStudent(
		mux,
		userKAID,
		[]cross_service.DistrictSchoolGrade{
			{
				DistrictID: "district_1",
				SchoolID:   "school_1",
				GradeLevel: "SIXTH",
			},
		},
	)

	ctx.GraphQLClient = gqlclient.NewMockClient(mux)

	err = users.MockUserExists(suite.KAContext(), userKAID)
	suite.Require().NoError(err)

	// Build GraphQL client
	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	mutation := `
		mutation Test_CreateUserAdaptiveAssessment($userKaid: String!) {
			createUserAdaptiveAssessment(userKaid: $userKaid) {
				assessment {
					userKAID
					blueprintID
					currentItemID
					responses {
						itemID
					}
				}
				error {
					message
					code
				}
			}
		}
	`

	// Execute mutation through GraphQL
	resp, err := gqltest.Mutate(ctx, client.AsUser(), mutation, js.Obj{
		"userKaid": userKAID,
	})
	suite.Require().NoError(err)
	suite.Require().NotNil(resp)

	// Verify response
	resultRaw, ok := resp["createUserAdaptiveAssessment"].(map[string]interface{})
	suite.Require().True(ok, "Should have createUserAdaptiveAssessment field")
	suite.Require().Nil(resultRaw["error"], "Should have no error")

	assessmentRaw, ok := resultRaw["assessment"].(map[string]interface{})
	suite.Require().True(ok, "Should have assessment")
	suite.Require().Equal(userKAID, assessmentRaw["userKAID"])
	suite.Require().NotNil(
		assessmentRaw["currentItemID"],
		"CurrentItemID should be set on creation",
	)

	responses := assessmentRaw["responses"].([]interface{})
	suite.Require().Empty(responses, "Should start with empty responses")

	// Verify it was saved to datastore
	savedAssessment, err := adaptive_test.GetLatestUserAdaptiveAssessment(ctx, userKAID)
	suite.Require().NoError(err)
	suite.Require().NotNil(savedAssessment)
	suite.Require().Equal(userKAID, savedAssessment.UserKAID)
	suite.Require().NotNil(
		savedAssessment.CurrentItemID,
		"CurrentItemID should be set on creation",
	)
	suite.Require().Empty(savedAssessment.Responses)
}

func (suite *gapDetectorSuite) TestCreateUserAdaptiveAssessmentDuplicateAssessmentID() {
	ctx := suite.KAContext().Clone()
	ctx.RequestData.User.HasAnyPermissions = true

	// Create a blueprint for grade 6 that the test will use
	blueprint := models.NewBlueprint(6)
	blueprintKey, err := adaptive_test.PutBlueprint(ctx, blueprint)
	suite.Require().NoError(err)
	suite.Require().NotNil(blueprintKey)

	// Mock admin permissions
	mux := gqlclient.NewMux()
	acl.MockActorPermissions(mux, ctx.User, []acl.MockPermission{
		{Capability: capabilities.CanDoWhatOnlyAdminsCanDo, Scope: acl.MockGlobalScope},
	})
	userKAID := "user-kaid-1234"

	// Mock districts data to return grade 6
	cross_service.MockGetDistrictSchoolGradeForStudent(
		mux,
		userKAID,
		[]cross_service.DistrictSchoolGrade{
			{
				DistrictID: "district_1",
				SchoolID:   "school_1",
				GradeLevel: "SIXTH",
			},
		},
	)

	err = users.MockUserExists(suite.KAContext(), userKAID)
	suite.Require().NoError(err)

	ctx.GraphQLClient = gqlclient.NewMockClient(mux)

	assessmentID := blueprintKey.ID

	// Create manager for ability calculations
	items, blueprintConfig, exerciseMap, err := adaptive_test.GetItemBank(ctx, 0)
	suite.Require().NoError(err)
	manager := adaptive_test.NewBlueprintManager(items, blueprintConfig, exerciseMap)

	// Create the first assessment manually
	firstAssessment := models.NewUserAdaptiveAssessment(userKAID, assessmentID)
	newResp := adaptive_test.Response{ItemID: "xe969f1c2bda72ec0", Score: 1.0}
	allResp := append(adaptive_test.ToResponses(firstAssessment.Responses), newResp)
	theta, se, weights, err := manager.CalculateAbility(allResp, 0.0)
	suite.Require().NoError(err)
	firstAssessment.AddResponse("xe969f1c2bda72ec0", 1.0, "test-answer", theta, se, weights)
	currentItemID1 := "x147aad123a743f14"
	firstAssessment.CurrentItemID = &currentItemID1
	err = adaptive_test.PutUserAdaptiveAssessment(ctx, firstAssessment)
	suite.Require().NoError(err)

	// Build GraphQL client
	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	mutation := `
		mutation Test_CreateUserAdaptiveAssessment($userKaid: String!) {
			createUserAdaptiveAssessment(userKaid: $userKaid) {
				assessment {
					userKAID
					currentItemID
					responses {
						itemID
					}
				}
				error {
					message
					code
				}
			}
		}
	`

	// Execute mutation through GraphQL to create a second assessment
	resp, err := gqltest.Mutate(ctx, client.AsUser(), mutation, js.Obj{
		"userKaid": userKAID,
	})
	suite.Require().NoError(err)
	suite.Require().NotNil(resp)

	// Verify response
	resultRaw, ok := resp["createUserAdaptiveAssessment"].(map[string]interface{})
	suite.Require().True(ok, "Should have createUserAdaptiveAssessment field")
	suite.Require().Nil(resultRaw["error"], "Should have no error")

	assessmentRaw, ok := resultRaw["assessment"].(map[string]interface{})
	suite.Require().True(ok, "Should have assessment")
	suite.Require().Equal(userKAID, assessmentRaw["userKAID"])
	suite.Require().NotNil(
		assessmentRaw["currentItemID"],
		"CurrentItemID should be set on creation",
	)

	responses := assessmentRaw["responses"].([]interface{})
	suite.Require().Empty(responses, "New assessment should start with empty responses")

	// Verify both assessments exist in datastore
	allAssessments, err := adaptive_test.GetUserAdaptiveAssessmentsByUser(ctx, userKAID)
	suite.Require().NoError(err)
	suite.Require().Len(allAssessments, 2, "Should have both the original and new assessment")

	// Verify we can get the latest assessment
	latestAssessment, err := adaptive_test.GetLatestUserAdaptiveAssessment(ctx, userKAID)
	suite.Require().NoError(err)
	suite.Require().NotNil(latestAssessment)
	suite.Require().Equal(userKAID, latestAssessment.UserKAID)
	suite.Require().Empty(
		latestAssessment.Responses,
		"Latest assessment should be the newly created one with empty responses",
	)
	suite.Require().False(
		latestAssessment.CreatedAt.IsZero(),
		"CreatedAt should be set on the latest assessment",
	)
}

func (suite *gapDetectorSuite) TestGetNextAssessmentItem_HappyPath() {
	// Arrange - Create test context and mock GraphQL client
	ctx := suite.KAContext().Clone()
	mux := gqlclient.NewMux()

	// Mock assessment items (used by both query and mutation)
	cross_service.MockGetAssessmentItemById(
		mux,
		"xf24bd181",
		"xe969f1c2bda72ec0",
		`{"question":{"content":"What is 2 + 3?"}, "answerArea": {"calculator": false}}`,
	)
	cross_service.MockGetAssessmentItemById(
		mux,
		"xf24bd181",
		"x147aad123a743f14",
		`{"question":{"content":"Solve for x: 2x + 5 = 11"}, "answerArea": {"calculator": false}}`,
	)
	cross_service.MockGetAssessmentItemById(
		mux,
		"xf24bd181",
		"xf81acc1058c5dbcc",
		`{"question":{"content":"What is 7 * 6?"}, "answerArea": {"calculator": false}}`,
	)

	// Create an assessment first before querying for it
	setupCtx := suite.KAContext().Clone()
	userKAID := "kaid1234"
	assessmentID := int64(1) // Placeholder assessment ID

	assessment := models.NewUserAdaptiveAssessment(userKAID, assessmentID)
	currentItemID := "xe969f1c2bda72ec0"
	assessment.CurrentItemID = &currentItemID
	err := adaptive_test.PutUserAdaptiveAssessment(setupCtx, assessment)
	suite.Require().NoError(err, "Should create initial assessment")

	// Test: Apply selective HTTP mock that preserves GraphQL traffic
	ctx.HTTPClient = cross_service.MockScoreItemWithPerseusToReturnCorrectSelective(ctx.HTTPClient)

	ctx.GraphQLClient = gqlclient.NewMockClient(mux) // Created AFTER HTTP mock
	ctx.RequestData.User.Kaid = userKAID

	suite.T().Logf("HTTP mock applied BEFORE GraphQL mock - does this work?")

	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	getQuery := `
		query Test_GetNextAssessmentItem {
			getNextAssessmentItem {
				item {
					id
					content
				}
				currentIndex
				totalItems
				isComplete
			}
		}
	`

	// Act & Assert - Simulate realistic assessment flow

	// Step 1: Query to get first item (debug the basic call first)
	resp1, err := gqltest.Query(ctx, client.AsUser(), getQuery, js.Obj{})
	if err != nil {
		suite.T().Logf("Error calling getNextAssessmentItem: %v", err)
		suite.Require().FailNow("Failed to call getNextAssessmentItem")
	}
	if resp1 == nil {
		suite.T().Logf("Response is nil")
		suite.Require().FailNow("Response is nil")
	}
	suite.T().Logf("Response: %+v", resp1)

	// Verify structure and basic properties
	getNextResp, ok := resp1["getNextAssessmentItem"].(map[string]interface{})
	suite.Require().True(ok, "Should have getNextAssessmentItem field")
	suite.Require().NotNil(getNextResp["item"], "Should return an item")
	suite.Require().Equal(1, int(getNextResp["currentIndex"].(float64)), "Should be first item")
	suite.Require().Equal(
		10,
		int(getNextResp["totalItems"].(float64)),
		"Should have 10 total items",
	)
	suite.Require().Equal(false, getNextResp["isComplete"], "Should not be complete")

	// Get the first item details
	firstItem, ok := getNextResp["item"].(map[string]interface{})
	suite.Require().True(ok, "Should have item object")
	firstItemID := firstItem["id"].(string)
	suite.Require().Contains(
		[]string{"xe969f1c2bda72ec0", "x147aad123a743f14", "xf81acc1058c5dbcc"},
		firstItemID,
		"Should be one of our test items",
	)
	suite.T().Logf("First item selected: %s", firstItemID)

	// Now test the mutation
	submitMutation := `
		mutation SubmitAssessmentAnswer($userAnswer: String!) {
			submitAssessmentAnswer(userAnswer: $userAnswer) {
				totalItems
				isComplete
				score
			}
		}
	`

	// Step 2: Submit answer to first item
	resp2, err := gqltest.Mutate(ctx, client.AsUser(), submitMutation, js.Obj{
		"userAnswer": "42", // Correct answer
	})
	suite.Require().NoError(err, "Should submit answer successfully")
	suite.T().Logf("Submit response: %+v", resp2)

	// Verify submission response
	submitResp, ok := resp2["submitAssessmentAnswer"].(map[string]interface{})
	suite.Require().True(ok, "Should have submitAssessmentAnswer field")
	suite.Require().Equal(
		1,
		int(submitResp["score"].(float64)),
		"Answer should be scored as correct",
	)
	suite.Require().Equal(false, submitResp["isComplete"], "Should not be complete yet")

	// Step 3: Submit answer to second item
	resp3, err := gqltest.Mutate(ctx, client.AsUser(), submitMutation, js.Obj{
		"userAnswer": "123", // Different answer
	})
	suite.Require().NoError(err, "Should submit third answer successfully")
	suite.T().Logf("Third response: %+v", resp3)

	// Verify third response
	submitResp3, ok := resp3["submitAssessmentAnswer"].(map[string]interface{})
	suite.Require().True(ok, "Should have submitAssessmentAnswer field")
	// Note: Mock scoring might return correct for any answer, so we just
	// verify structure
	suite.T().Logf("Third answer score: %v", submitResp3["score"])

	// Step 4: Submit one more answer to see blueprint behavior
	resp4, err := gqltest.Mutate(ctx, client.AsUser(), submitMutation, js.Obj{
		"userAnswer": "5", // Another answer
	})
	suite.Require().NoError(err, "Should submit fourth answer successfully")
	suite.T().Logf("Fourth response: %+v", resp4)

	// At this point, with our small pool (3 items) and blueprint constraints,
	// the assessment should either be complete or close to complete
	submitResp4, ok := resp4["submitAssessmentAnswer"].(map[string]interface{})
	suite.Require().True(ok, "Should have submitAssessmentAnswer field")
	suite.T().Logf("Assessment complete status: %v", submitResp4["isComplete"])

	// Step 5: Test that querying again works (either continues or restarts)
	resp5, err := gqltest.Query(ctx, client.AsUser(), getQuery, js.Obj{})
	suite.Require().NoError(err, "Should handle query after submission")
	suite.T().Logf("Final query response: %+v", resp5)

	// Should always return a valid response structure
	finalResp, ok := resp5["getNextAssessmentItem"].(map[string]interface{})
	suite.Require().True(ok, "Should have getNextAssessmentItem field")
	currentIndex := int(finalResp["currentIndex"].(float64))
	suite.Require().Contains([]int{1, 2, 3, 4, 5}, currentIndex,
		"Should have valid current index")
	suite.T().Logf("Blueprint assessment journey completed successfully!")
}

func (suite *gapDetectorSuite) TestGetNextAssessmentItem_LogCedar() {
	// Arrange - Create test context and assessment
	ctx := suite.KAContext().Clone()
	mux := gqlclient.NewMux()

	// Mock assessment item for answerless response
	cross_service.MockGetAssessmentItemById(
		mux,
		"xf24bd181",
		"xe969f1c2bda72ec0",
		`{"question":{"content":"What is 2 + 3?"}}`,
	)

	// Create an assessment with a current item
	setupCtx := suite.KAContext().Clone()
	userKAID := "kaid_cedar_test"
	assessmentID := int64(1)

	assessment := models.NewUserAdaptiveAssessment(userKAID, assessmentID)
	currentItemID := "xe969f1c2bda72ec0"
	assessment.CurrentItemID = &currentItemID
	err := adaptive_test.PutUserAdaptiveAssessment(setupCtx, assessment)
	suite.Require().NoError(err)

	ctx.GraphQLClient = gqlclient.NewMockClient(mux)
	ctx.RequestData.User.Kaid = userKAID

	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	getQuery := `
		query Test_GetNextAssessmentItem_LogCedar {
			getNextAssessmentItem {
				item {
					id
					content
				}
				currentIndex
				totalItems
				isComplete
			}
		}
	`

	// Act - Query to get next item
	resp, err := gqltest.Query(ctx, client.AsUser(), getQuery, js.Obj{})
	suite.Require().NoError(err)
	suite.Require().NotNil(resp)

	// Verify CEDAR event for item viewed was published
	messages := ctx.Pubsub().ServerForTests().Messages()
	suite.Require().Equal(1, len(messages))

	// Manually verify the event fields (excluding timestamp which is hard
	// to match in tests)
	var event analytics_events.GapDetectorItemViewedTIV1
	err = json.Unmarshal(messages[0].Data, &event)
	suite.Require().NoError(err)
	suite.Require().Equal(userKAID, event.Kaid)
	suite.Require().Equal(strconv.FormatInt(assessmentID, 10), event.BlueprintId)
	suite.Require().Equal(assessment.Key.Name, event.AttemptId)
	suite.Require().Equal(currentItemID, event.ItemId)
	suite.Require().Equal(int64(0), event.ResponseCount)
	// Note: We skip ItemSeenAtTimestamp verification as it's difficult to
	// match in test environment
}

func (suite *gapDetectorSuite) TestGetNextAssessmentItem_AssessmentNotFound() {
	// Arrange - Create test context WITHOUT creating an assessment
	ctx := suite.KAContext().Clone()
	kaid := "user_with_no_assessment"
	ctx.RequestData.User.Kaid = kaid

	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	getQuery := `
		query Test_GetNextAssessmentItem_NotFound {
			getNextAssessmentItem {
				item {
					id
					content
				}
				currentIndex
				totalItems
				isComplete
				error {
					code
					debugMessage
				}
			}
		}
	`

	// Act - Query for assessment that doesn't exist
	resp, err := gqltest.Query(ctx, client.AsUser(), getQuery, js.Obj{})

	// Assert - Should get a successful response with error field populated
	suite.T().Logf("Response: %+v", resp)
	suite.T().Logf("Error: %+v", err)

	// GraphQL call should succeed (no error), but response should have
	// error field
	suite.Require().NoError(err, "GraphQL query should succeed")
	suite.Require().NotNil(resp, "Response should not be nil")

	// Check that we get a response with the error field populated
	getNextResp, ok := resp["getNextAssessmentItem"].(map[string]interface{})
	suite.Require().True(ok, "Should have getNextAssessmentItem field")

	// Check for error field in the response
	errorField, hasError := getNextResp["error"]
	suite.Require().True(hasError, "Response should have error field")
	suite.Require().NotNil(errorField, "Error field should not be nil")

	// Check the error code
	errorObj, ok := errorField.(map[string]interface{})
	suite.Require().True(ok, "Error should be an object")

	errorCode, ok := errorObj["code"].(string)
	suite.Require().True(ok, "Error should have code field")
	suite.Require().Equal(
		"ASSESSMENT_NOT_FOUND",
		errorCode,
		"Should return ASSESSMENT_NOT_FOUND error code",
	)
}

func (suite *gapDetectorSuite) TestGetNextAssessmentItem_AssessmentComplete() {
	// Arrange - Create test context with a completed assessment
	// (CurrentItemID = nil)
	ctx := suite.KAContext().Clone()
	setupCtx := suite.KAContext().Clone()

	userKAID := "kaid1234"
	assessmentID := int64(1)

	// Create manager for ability calculations
	items, blueprint, exerciseMap, err := adaptive_test.GetItemBank(setupCtx, 0)
	suite.Require().NoError(err)
	manager := adaptive_test.NewBlueprintManager(items, blueprint, exerciseMap)

	// Create a completed assessment with responses but no CurrentItemID
	assessment := models.NewUserAdaptiveAssessment(userKAID, assessmentID)
	assessment.CurrentItemID = nil // Mark as complete
	// Add mock responses to show it had activity
	newResponse1 := adaptive_test.Response{ItemID: "xe969f1c2bda72ec0", Score: 1.0}
	allResponses1 := append(adaptive_test.ToResponses(assessment.Responses), newResponse1)
	theta1, se1, weights1, err := manager.CalculateAbility(allResponses1, 0.0)
	suite.Require().NoError(err)
	assessment.AddResponse("xe969f1c2bda72ec0", 1.0, "test-answer", theta1, se1, weights1)

	newResponse2 := adaptive_test.Response{ItemID: "x147aad123a743f14", Score: 0.0}
	allResponses2 := append(adaptive_test.ToResponses(assessment.Responses), newResponse2)
	theta2, se2, weights2, err := manager.CalculateAbility(allResponses2, 0.0)
	suite.Require().NoError(err)
	assessment.AddResponse("x147aad123a743f14", 0.0, "test-answer", theta2, se2, weights2)

	newResponse3 := adaptive_test.Response{ItemID: "xf81acc1058c5dbcc", Score: 1.0}
	allResponses3 := append(adaptive_test.ToResponses(assessment.Responses), newResponse3)
	theta3, se3, weights3, err := manager.CalculateAbility(allResponses3, 0.0)
	suite.Require().NoError(err)
	assessment.AddResponse("xf81acc1058c5dbcc", 1.0, "test-answer", theta3, se3, weights3)

	err = adaptive_test.PutUserAdaptiveAssessment(setupCtx, assessment)
	suite.Require().NoError(err, "Should create completed assessment")

	ctx.RequestData.User.Kaid = userKAID

	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	getQuery := `
		query Test_GetNextAssessmentItem_Complete {
			getNextAssessmentItem {
				item {
					id
					content
				}
				currentIndex
				totalItems
				isComplete
			}
		}
	`

	// Act - Query for next item when assessment is complete
	resp, err := gqltest.Query(ctx, client.AsUser(), getQuery, js.Obj{})

	// Assert - Should return complete status without error
	suite.Require().NoError(err, "Should handle completed assessment gracefully")
	suite.Require().NotNil(resp, "Response should not be nil")

	getNextResp, ok := resp["getNextAssessmentItem"].(map[string]interface{})
	suite.Require().True(ok, "Should have getNextAssessmentItem field")

	// Verify completion response
	suite.Require().Nil(getNextResp["item"], "Item should be nil when complete")
	suite.Require().Equal(
		3,
		int(getNextResp["currentIndex"].(float64)),
		"CurrentIndex should match response count",
	)
	suite.Require().Equal(10, int(getNextResp["totalItems"].(float64)), "TotalItems should be set")
	suite.Require().Equal(true, getNextResp["isComplete"], "Should indicate assessment is complete")
}

func (suite *gapDetectorSuite) TestGetNextAssessmentItem_WithMultipleAssessments() {
	// Arrange - Create test context with
	// TWO assessments to verify we get the latest one
	ctx := suite.KAContext().Clone()
	setupCtx := suite.KAContext().Clone()
	mux := gqlclient.NewMux()

	userKAID := "kaid5678"
	assessmentID := int64(999)

	// Create manager for ability calculations
	items, blueprint, exerciseMap, err := adaptive_test.GetItemBank(setupCtx, 0)
	suite.Require().NoError(err)
	manager := adaptive_test.NewBlueprintManager(items, blueprint, exerciseMap)

	// Create FIRST assessment with specific CurrentItemID (using real item ID)
	firstAssessment := models.NewUserAdaptiveAssessment(userKAID, assessmentID)
	newResponse1 := adaptive_test.Response{ItemID: "xe969f1c2bda72ec0", Score: 1.0}
	allResponses1 := append(adaptive_test.ToResponses(firstAssessment.Responses), newResponse1)
	theta1, se1, weights1, err := manager.CalculateAbility(allResponses1, 0.0)
	suite.Require().NoError(err)
	firstAssessment.AddResponse("xe969f1c2bda72ec0", 1.0, "test-answer", theta1, se1, weights1)
	firstCurrentItemID := "x147aad123a743f14" // Real item ID from existing tests
	firstAssessment.CurrentItemID = &firstCurrentItemID
	err = adaptive_test.PutUserAdaptiveAssessment(setupCtx, firstAssessment)
	suite.Require().NoError(err, "Should create first assessment")

	// Create SECOND assessment (newer)
	// with DIFFERENT CurrentItemID (using different real item ID)
	secondAssessment := models.NewUserAdaptiveAssessment(userKAID, assessmentID)
	newResponse2 := adaptive_test.Response{ItemID: "x147aad123a743f14", Score: 0.5}
	allResponses2 := append(adaptive_test.ToResponses(secondAssessment.Responses), newResponse2)
	theta2, se2, weights2, err := manager.CalculateAbility(allResponses2, 0.0)
	suite.Require().NoError(err)
	secondAssessment.AddResponse("x147aad123a743f14", 0.5, "test-answer", theta2, se2, weights2)
	secondCurrentItemID := "xf81acc1058c5dbcc" // Different real item ID from existing tests
	secondAssessment.CurrentItemID = &secondCurrentItemID
	err = adaptive_test.PutUserAdaptiveAssessment(setupCtx, secondAssessment)
	suite.Require().NoError(err, "Should create second assessment")

	// Mock the assessment item that should be returned (from SECOND assessment)
	cross_service.MockGetAssessmentItemById(
		mux,
		"xf24bd181",
		secondCurrentItemID,
		`{"question":{"content":"Latest assessment question"}}`,
	)

	ctx.GraphQLClient = gqlclient.NewMockClient(mux)
	ctx.RequestData.User.Kaid = userKAID

	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	getQuery := `
		query Test_GetNextAssessmentItem_MultipleAssessments {
			getNextAssessmentItem {
				item {
					id
					content
				}
				currentIndex
				totalItems
				isComplete
				error {
					code
					debugMessage
				}
			}
		}
	`

	// Act - Query for next assessment item
	resp, err := gqltest.Query(ctx, client.AsUser(), getQuery, js.Obj{})

	// Assert - Should return item from LATEST (second) assessment, NOT first
	suite.Require().NoError(err)
	suite.Require().NotNil(resp)

	getNextResp, ok := resp["getNextAssessmentItem"].(map[string]interface{})
	suite.Require().True(ok)

	// Verify no error occurred
	suite.Require().Nil(getNextResp["error"], "Should not have error")

	// Verify we got the item from the SECOND (latest) assessment
	item, ok := getNextResp["item"].(map[string]interface{})
	suite.Require().True(ok, "Should have item")
	suite.Require().NotNil(item, "Item should not be nil")

	itemID, ok := item["id"].(string)
	suite.Require().True(ok, "Should have item ID")
	suite.Require().Equal(
		secondCurrentItemID,
		itemID,
		"Should return CurrentItemID from LATEST assessment, not first assessment",
	)

	// Verify the content is from the mocked latest assessment item
	content, ok := item["content"].(string)
	suite.Require().True(ok, "Should have content")
	suite.Require().Contains(content, "Latest assessment question")

	// Verify other response fields
	suite.Require().Equal(2, int(getNextResp["currentIndex"].(float64)))
	suite.Require().Equal(10, int(getNextResp["totalItems"].(float64)))
	suite.Require().Equal(false, getNextResp["isComplete"])

	// Additional verification:
	// Confirm we have multiple assessments in datastore
	allAssessments, err := adaptive_test.GetUserAdaptiveAssessmentsByUser(setupCtx, userKAID)
	suite.Require().NoError(err)
	suite.Require().Len(allAssessments, 2)

	// Verify the latest assessment is indeed the second one
	latestAssessment, err := adaptive_test.GetLatestUserAdaptiveAssessment(setupCtx, userKAID)
	suite.Require().NoError(err)
	suite.Require().NotNil(latestAssessment.CurrentItemID)
	suite.Require().Equal(
		secondCurrentItemID,
		*latestAssessment.CurrentItemID,
		"Latest assessment should have second CurrentItemID",
	)
}

func (suite *gapDetectorSuite) TestSubmitAssessmentAnswerCorrect() {
	// Arrange - Create test context and mock GraphQL client
	ctx := suite.KAContext().Clone()
	mux := gqlclient.NewMux()

	// Create a UserAdaptiveAssessment first with an initial CurrentItemID
	// Use a fresh context to avoid transaction safety issues
	setupCtx := suite.KAContext().Clone()
	userKAID := "kaid_1234"
	assessmentID := int64(1)
	assessment := models.NewUserAdaptiveAssessment(userKAID, assessmentID)
	currentItemID := "xe969f1c2bda72ec0"
	assessment.CurrentItemID = &currentItemID
	err := adaptive_test.PutUserAdaptiveAssessment(setupCtx, assessment)
	suite.Require().NoError(err, "Should create initial assessment")

	// Mock the assessment item for scoring (mutation needs the full data
	// with answers)
	cross_service.MockGetAssessmentItemById(
		mux,
		"xf24bd181",
		currentItemID,
		`{"question":{"content":"What is 2 + 3?"}, "answerArea": {"calculator": false}, "hints": []}`,
	)

	// Mock scoring to return correct answer
	ctx.HTTPClient = cross_service.MockScoreItemWithPerseusToReturnCorrectSelective(ctx.HTTPClient)

	ctx.GraphQLClient = gqlclient.NewMockClient(mux)
	ctx.RequestData.User.Kaid = userKAID

	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	submitMutation := `
		mutation SubmitAssessmentAnswer($userAnswer: String!) {
			submitAssessmentAnswer(userAnswer: $userAnswer) {
				totalItems
				isComplete
				score
			}
		}
	`

	// Clear any existing messages before the mutation
	ctx.Pubsub().ServerForTests().ClearMessages()

	// Act - Submit a correct answer
	resp, err := gqltest.Mutate(ctx, client.AsUser(), submitMutation, js.Obj{
		"userAnswer": "5", // Correct answer to "What is 2 + 3?"
	})

	// Assert - Verify score is correct for a correct answer
	suite.Require().NoError(err)
	suite.Require().NotNil(resp)

	submitResp, ok := resp["submitAssessmentAnswer"].(map[string]interface{})
	suite.Require().True(ok)

	suite.Require().Equal(10.0, submitResp["totalItems"])
	suite.Require().Equal(false, submitResp["isComplete"])
	suite.Require().Equal(1.0, submitResp["score"])

	// Verify CEDAR event for item answered was published
	messages := ctx.Pubsub().ServerForTests().Messages()
	suite.Require().GreaterOrEqual(len(messages), 1)

	// Fetch the updated assessment to get the actual values
	updatedAssessment, err := adaptive_test.GetLatestUserAdaptiveAssessment(ctx, userKAID)
	suite.Require().NoError(err)
	suite.Require().Len(updatedAssessment.Responses, 1)

	latestResponse := updatedAssessment.Responses[0]
	weightsJSON, err := json.Marshal(latestResponse.Weights)
	suite.Require().NoError(err)

	// verify the ItemAnswered event fields (excluding timestamp)
	var event analytics_events.GapDetectorItemAnsweredTIV1
	err = json.Unmarshal(messages[len(messages)-1].Data, &event)
	suite.Require().NoError(err)
	suite.Require().Equal(userKAID, event.Kaid)
	suite.Require().Equal(true, event.IsCorrect)
	suite.Require().Equal(strconv.FormatInt(assessmentID, 10), event.BlueprintId)
	suite.Require().Equal(updatedAssessment.Key.Name, event.AttemptId)
	suite.Require().Equal(currentItemID, event.ItemId)
	suite.Require().Equal("5", event.Response)
	suite.Require().Equal(latestResponse.Theta, event.Theta)
	suite.Require().Equal(latestResponse.ThetaStandardError, event.ThetaStandardError)
	suite.Require().Equal(string(weightsJSON), event.Weights)
	suite.Require().Equal(int64(1), event.ResponseCount)
	// Note: We skip AnsweredAtTimestamp verification as it's difficult to
	// match in test environment
}

func (suite *gapDetectorSuite) TestSubmitAnswerUpdatesCurrentItemID() {
	// Arrange - Create test context and mock GraphQL client
	ctx := suite.KAContext().Clone()
	mux := gqlclient.NewMux()

	// Create a fresh UserAdaptiveAssessment with a known starting CurrentItemID
	setupCtx := suite.KAContext().Clone()
	userKAID := "kaid_12345"
	assessmentID := int64(1) // Must match resolver's hardcoded assessment ID

	// Create fresh assessment
	assessment := models.NewUserAdaptiveAssessment(userKAID, assessmentID)
	startingItemID := "xe969f1c2bda72ec0"
	assessment.CurrentItemID = &startingItemID
	err := adaptive_test.PutUserAdaptiveAssessment(setupCtx, assessment)
	suite.Require().NoError(err, "Should create initial assessment")

	// Mock the current assessment item for scoring
	cross_service.MockGetAssessmentItemById(
		mux,
		"xf24bd181",
		startingItemID,
		`{"question":{"content":"What is 2 + 3?"}, "answerArea": {"calculator": false}, "hints": []}`,
	)

	// Mock scoring to return incorrect answer
	ctx.HTTPClient = cross_service.MockScoreItemWithPerseusToReturnIncorrectSelective(
		ctx.HTTPClient,
	)

	ctx.GraphQLClient = gqlclient.NewMockClient(mux)
	ctx.RequestData.User.Kaid = userKAID

	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	submitMutation := `
		mutation SubmitAssessmentAnswer($userAnswer: String!) {
			submitAssessmentAnswer(userAnswer: $userAnswer) {
				totalItems
				isComplete
				score
			}
		}
	`

	// Act - Submit an incorrect answer
	_, err = gqltest.Mutate(ctx, client.AsUser(), submitMutation, js.Obj{
		"userAnswer": "3", // Incorrect answer to "What is 2 + 3?"
	})
	suite.Require().NoError(err)

	// Assert - Verify the CurrentItemID has been updated to the next item
	// Read the assessment back from the datastore to check CurrentItemID
	updatedAssessment, err := adaptive_test.GetLatestUserAdaptiveAssessment(ctx, userKAID)
	suite.Require().NoError(err)
	suite.Require().NotNil(updatedAssessment)
	suite.Require().NotNil(updatedAssessment.CurrentItemID)

	newCurrentItemID := *updatedAssessment.CurrentItemID
	suite.Require().NotEqual(startingItemID, newCurrentItemID,
		"CurrentItemID should be updated to a different item after submission")

	// Verify we now have one response recorded
	suite.Require().Len(updatedAssessment.Responses, 1, "Should have exactly one response recorded")
	suite.Require().Equal(startingItemID, updatedAssessment.Responses[0].ItemID,
		"First response should be for the original current item")
	suite.Require().Equal(0.0, updatedAssessment.Responses[0].Score,
		"Response should be scored as incorrect (0.0)")
}

func (suite *gapDetectorSuite) TestSubmitAssessmentAnswerWhenComplete() {
	// Arrange - Create test context and a completed assessment
	// (CurrentItemID = nil)
	ctx := suite.KAContext().Clone()
	setupCtx := suite.KAContext().Clone()

	userKAID := "kaid_123455"
	assessmentID := int64(1)

	// Create manager for ability calculations
	items, blueprint, exerciseMap, err := adaptive_test.GetItemBank(setupCtx, 0)
	suite.Require().NoError(err)
	manager := adaptive_test.NewBlueprintManager(items, blueprint, exerciseMap)

	// Create a completed assessment with some responses but no CurrentItemID
	assessment := models.NewUserAdaptiveAssessment(userKAID, assessmentID)
	assessment.CurrentItemID = nil // Mark as complete
	// Add a mock response to show it was previously active
	newResp := adaptive_test.Response{ItemID: "xe969f1c2bda72ec0", Score: 1.0}
	allResp := append(adaptive_test.ToResponses(assessment.Responses), newResp)
	theta, se, weights, err := manager.CalculateAbility(allResp, 0.0)
	suite.Require().NoError(err, "Should calculate ability with new response")
	assessment.AddResponse("xe969f1c2bda72ec0", 1.0, "test-answer", theta, se, weights)

	err = adaptive_test.PutUserAdaptiveAssessment(setupCtx, assessment)
	suite.Require().NoError(err, "Should create completed assessment")

	ctx.RequestData.User.Kaid = userKAID

	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	submitMutation := `
		mutation SubmitAssessmentAnswer($userAnswer: String!) {
			submitAssessmentAnswer(userAnswer: $userAnswer) {
				totalItems
				isComplete
				score
				error {
					code
					debugMessage
				}
			}
		}
	`

	// Act - Try to submit answer to completed assessment
	resp, err := gqltest.Mutate(ctx, client.AsUser(), submitMutation, js.Obj{
		"userAnswer": "5", // Any answer
	})

	// Assert - Should return error response but not throw exception
	suite.Require().NoError(err, "GraphQL call should succeed but return error in response")
	suite.Require().NotNil(resp)

	submitResp, ok := resp["submitAssessmentAnswer"].(map[string]interface{})
	suite.Require().True(ok)

	// Verify error field is populated
	errorField, hasError := submitResp["error"]
	suite.Require().True(hasError, "Response should have error field")
	suite.Require().NotNil(errorField, "Error field should not be nil")

	// Check the error code
	errorObj, ok := errorField.(map[string]interface{})
	suite.Require().True(ok, "Error should be an object")

	errorCode, ok := errorObj["code"].(string)
	suite.Require().True(ok, "Error should have code field")
	suite.Require().Equal(
		"ASSESSMENT_ALREADY_COMPLETE",
		errorCode,
		"Should return ASSESSMENT_ALREADY_COMPLETE error code",
	)

	// Verify other fields are set to defaults when error occurs
	suite.Require().Equal(
		0,
		int(submitResp["totalItems"].(float64)),
		"TotalItems should be 0 when error",
	)
	suite.Require().Equal(false, submitResp["isComplete"], "IsComplete should be false when error")
}

func (suite *gapDetectorSuite) TestSubmitAssessmentAnswerUntilComplete() {
	// Arrange - Create test context and mock GraphQL client
	ctx := suite.KAContext().Clone()
	mux := gqlclient.NewMux()

	// Create a UserAdaptiveAssessment with an initial CurrentItemID
	setupCtx := suite.KAContext().Clone()
	userKAID := "kaid_4577"
	assessmentID := int64(1)
	assessment := models.NewUserAdaptiveAssessment(userKAID, assessmentID)
	currentItemID := "xe969f1c2bda72ec0"
	assessment.CurrentItemID = &currentItemID
	err := adaptive_test.PutUserAdaptiveAssessment(setupCtx, assessment)
	suite.Require().NoError(err, "Should create initial assessment")

	// Mock all three assessment items that are used in the test
	cross_service.MockGetAssessmentItemById(
		mux,
		"xf24bd181",
		"xe969f1c2bda72ec0",
		`{"question":{"content":"What is 2 + 3?"}, "answerArea": {"calculator": false}, "hints": []}`,
	)
	cross_service.MockGetAssessmentItemById(
		mux,
		"xf24bd181",
		"x147aad123a743f14",
		`{"question":{"content":"Solve for x: 2x + 5 = 11"}, "answerArea": {"calculator": false}, "hints": []}`,
	)
	cross_service.MockGetAssessmentItemById(
		mux,
		"xf24bd181",
		"xf81acc1058c5dbcc",
		`{"question":{"content":"What is 7 * 6?"}, "answerArea": {"calculator": false}, "hints": []}`,
	)

	// Mock scoring to return correct answer
	ctx.HTTPClient = cross_service.MockScoreItemWithPerseusToReturnCorrectSelective(ctx.HTTPClient)

	ctx.GraphQLClient = gqlclient.NewMockClient(mux)
	ctx.RequestData.User.Kaid = userKAID

	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	submitMutation := `
		mutation SubmitAssessmentAnswer($userAnswer: String!) {
			submitAssessmentAnswer(userAnswer: $userAnswer) {
				totalItems
				isComplete
				score
			}
		}
	`

	// Act & Assert - Submit answers until assessment is complete

	// Submit first answer
	resp1, err := gqltest.Mutate(ctx, client.AsUser(), submitMutation, js.Obj{
		"userAnswer": "5", // Correct answer to "What is 2 + 3?"
	})
	suite.Require().NoError(err, "Should submit first answer successfully")

	submitResp1, ok := resp1["submitAssessmentAnswer"].(map[string]interface{})
	suite.Require().True(ok)
	suite.Require().Equal(
		false,
		submitResp1["isComplete"],
		"Should not be complete after first answer",
	)
	suite.Require().Equal(1, int(submitResp1["score"].(float64)), "First answer should be correct")

	// Submit second answer
	resp2, err := gqltest.Mutate(ctx, client.AsUser(), submitMutation, js.Obj{
		"userAnswer": "3", // Correct answer to "Solve for x: 2x + 5 = 11"
	})
	suite.Require().NoError(err, "Should submit second answer successfully")

	submitResp2, ok := resp2["submitAssessmentAnswer"].(map[string]interface{})
	suite.Require().True(ok)
	suite.Require().Equal(
		false,
		submitResp2["isComplete"],
		"Should not be complete after second answer",
	)
	suite.Require().Equal(1, int(submitResp2["score"].(float64)), "Second answer should be correct")

	// Submit third answer - this should complete the assessment since we
	// only have 3 test items
	resp3, err := gqltest.Mutate(ctx, client.AsUser(), submitMutation, js.Obj{
		"userAnswer": "42", // Correct answer to "What is 7 * 6?"
	})
	suite.Require().NoError(err, "Should submit third answer successfully")

	submitResp3, ok := resp3["submitAssessmentAnswer"].(map[string]interface{})
	suite.Require().True(ok)
	suite.Require().Equal(
		true,
		submitResp3["isComplete"],
		"Should be complete after third answer (no more items available)",
	)
	suite.Require().Equal(1, int(submitResp3["score"].(float64)), "Third answer should be correct")

	// Verify assessment is actually marked as complete in the datastore
	finalAssessment, err := adaptive_test.GetLatestUserAdaptiveAssessment(ctx, userKAID)
	suite.Require().NoError(err)
	suite.Require().NotNil(finalAssessment)
	suite.Require().Nil(
		finalAssessment.CurrentItemID,
		"CurrentItemID should be nil when assessment is complete",
	)
	suite.Require().Len(finalAssessment.Responses, 3, "Should have exactly 3 responses recorded")

	// Verify all responses are correct
	for i, response := range finalAssessment.Responses {
		suite.Require().Equal(1.0, response.Score, "Response %d should be scored as correct", i+1)
	}
}

func (suite *gapDetectorSuite) TestCannotSubmitAnswerWhenAssessmentNotFound() {
	// Arrange - Create test context with userKAID mismatch
	ctx := suite.KAContext().Clone()
	setupCtx := suite.KAContext().Clone()

	// Distractor data: UAAs exist, but not for current request user
	assessmentOwnerKAID := "kaid_1111"
	assessmentID := int64(1)
	assessment := models.NewUserAdaptiveAssessment(assessmentOwnerKAID, assessmentID)
	currentItemID := "xe969f1c2bda72ec0"
	assessment.CurrentItemID = &currentItemID
	err := adaptive_test.PutUserAdaptiveAssessment(setupCtx, assessment)
	suite.Require().NoError(err, "Should create assessment for original user")

	// Set requesting user to a different KAID
	requestingUserKAID := "kaid_2222"
	ctx.RequestData.User.Kaid = requestingUserKAID

	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	submitMutation := `
		mutation SubmitAssessmentAnswer($userAnswer: String!) {
			submitAssessmentAnswer(userAnswer: $userAnswer) {
				totalItems
				isComplete
				score
				error {
					code
					debugMessage
				}
			}
		}
	`

	// Act - Try to submit answer with a user who does not have an assessment
	resp, err := gqltest.Mutate(ctx, client.AsUser(), submitMutation, js.Obj{
		"userAnswer": "5", // Any answer
	})

	// Assert - Should return error response but not throw exception
	suite.Require().NoError(err, "GraphQL call should succeed but return error in response")
	suite.Require().NotNil(resp)

	submitResp, ok := resp["submitAssessmentAnswer"].(map[string]interface{})
	suite.Require().True(ok)

	// Verify error field is populated
	errorField, hasError := submitResp["error"]
	suite.Require().True(hasError)
	suite.Require().NotNil(errorField, "Error field should not be nil")

	// Check the error code
	errorObj, ok := errorField.(map[string]interface{})
	suite.Require().True(ok)
	errorCode, ok := errorObj["code"].(string)
	suite.Require().True(ok)
	suite.Require().Equal(
		"ASSESSMENT_NOT_FOUND",
		errorCode,
	)
}

// Helper function tests (these test internal functions, not resolvers)

func (suite *gapDetectorSuite) TestParseGradeLevel() {
	testCases := []struct {
		name          string
		gradeLevel    string
		expectedGrade int
		shouldError   bool
	}{
		{
			name:          "SIXTH grade",
			gradeLevel:    "SIXTH",
			expectedGrade: 6,
			shouldError:   false,
		},
		{
			name:          "THIRD grade",
			gradeLevel:    "THIRD",
			expectedGrade: 3,
			shouldError:   false,
		},
		{
			name:          "FIRST grade",
			gradeLevel:    "FIRST",
			expectedGrade: 1,
			shouldError:   false,
		},
		{
			name:          "SECOND grade",
			gradeLevel:    "SECOND",
			expectedGrade: 2,
			shouldError:   false,
		},
		{
			name:          "ELEVENTH grade",
			gradeLevel:    "ELEVENTH",
			expectedGrade: 11,
			shouldError:   false,
		},
		{
			name:          "TWELFTH grade",
			gradeLevel:    "TWELFTH",
			expectedGrade: 12,
			shouldError:   false,
		},
		{
			name:          "KINDER",
			gradeLevel:    "KINDER",
			expectedGrade: 14,
			shouldError:   false,
		},
		{
			name:        "invalid format - unknown grade level",
			gradeLevel:  "THIRTEENTH",
			shouldError: true,
		},
		{
			name:        "invalid format - empty string",
			gradeLevel:  "",
			shouldError: true,
		},
	}

	for _, tc := range testCases {
		suite.Run(tc.name, func() {
			grade, err := _parseGradeLevel(tc.gradeLevel)

			if tc.shouldError {
				suite.Require().Error(err)
			} else {
				suite.Require().NoError(err)
				suite.Require().Equal(tc.expectedGrade, grade)
			}
		})
	}
}

func (suite *gapDetectorSuite) TestGetStudentGrade() {
	ctx := suite.KAContext().Clone()
	mux := gqlclient.NewMux()

	userKAID := "test_user_with_grade"

	// Mock districts data with grade 3
	cross_service.MockGetDistrictSchoolGradeForStudent(
		mux,
		userKAID,
		[]cross_service.DistrictSchoolGrade{
			{
				DistrictID: "district_1",
				SchoolID:   "school_1",
				GradeLevel: "THIRD",
			},
		},
	)

	ctx.GraphQLClient = gqlclient.NewMockClient(mux)

	grade, err := _getStudentGrade(ctx, userKAID)
	suite.Require().NoError(err)
	suite.Require().Equal(3, grade)
}

func (suite *gapDetectorSuite) TestGetStudentGradeNoDistrictData() {
	ctx := suite.KAContext().Clone()
	mux := gqlclient.NewMux()

	userKAID := "test_user_no_grade"

	// Mock empty districts data
	cross_service.MockGetDistrictSchoolGradeForStudent(
		mux,
		userKAID,
		[]cross_service.DistrictSchoolGrade{},
	)

	ctx.GraphQLClient = gqlclient.NewMockClient(mux)

	grade, err := _getStudentGrade(ctx, userKAID)
	suite.Require().Error(err, "Should return error when no district data")
	suite.Require().Equal(0, grade)
	suite.Require().True(
		errors.Is(err, errors.InvalidInputKind),
		"Should return InvalidInput error for missing district data",
	)
}

func (suite *gapDetectorSuite) TestCreateUserAdaptiveAssessmentBatch() {
	ctx := suite.KAContext().Clone()
	ctx.RequestData.User.HasAnyPermissions = true

	// Mock admin permissions
	mux := gqlclient.NewMux()
	acl.MockActorPermissions(mux, ctx.User, []acl.MockPermission{
		{Capability: capabilities.CanDoWhatOnlyAdminsCanDo, Scope: acl.MockGlobalScope},
	})
	ctx.GraphQLClient = gqlclient.NewMockClient(mux)

	// Setup test task client to verify tasks are enqueued
	taskHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		suite.Require().Equal(http.MethodPost, r.Method)
		suite.Require().Contains(
			r.URL.Path,
			"/tasks/graphql/Progress_Task_createUserAdaptiveAssessment",
		)
		// Verify task secret is set
		suite.Require().NotEmpty(r.Header["X-Ka-Task-Secret"])
	})
	taskClient := taskstest.NewTestClient(taskHandler)
	ctx.TasksClient = taskClient
	taskServer := taskClient.TestServer()

	// Build GraphQL client
	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	mutation := `
		mutation Test_CreateUserAdaptiveAssessmentBatch($userKaids: [String!]!) {
			createUserAdaptiveAssessmentBatch(userKaids: $userKaids) {
				enqueuedCount
				failedUserKaids
				error {
					message
					code
				}
			}
		}
	`

	// Execute mutation through GraphQL
	userKaids := []string{"kaid_test_1", "kaid_test_2", "kaid_test_3"}
	resp, err := gqltest.Mutate(ctx, client.AsUser(), mutation, js.Obj{
		"userKaids": userKaids,
	})
	suite.Require().NoError(err)

	// Verify response
	expected := js.Obj{
		"createUserAdaptiveAssessmentBatch": js.Obj{
			"enqueuedCount":   3,
			"failedUserKaids": js.Array{},
			"error":           nil,
		},
	}
	suite.RequireJSONEqual(expected, resp)

	// Verify tasks are in the queue
	queuedTasks := taskServer.QueuedTasks()
	suite.Require().Len(queuedTasks, 3)

	// Verify each task contains exactly one userKaid
	enqueuedKaids := make(map[string]bool)
	for _, task := range queuedTasks {
		taskBody := string(task.Task.Body)
		// Find which kaid is in this task
		for _, kaid := range userKaids {
			if strings.Contains(taskBody, kaid) {
				enqueuedKaids[kaid] = true
				break // Each task should only contain one kaid
			}
		}
	}
	suite.Require().Len(enqueuedKaids, 3, "All 3 user KAIDs should each appear in exactly one task")
}

func (suite *gapDetectorSuite) TestCreateUserAdaptiveAssessmentBatch_Unauthorized() {
	ctx := suite.KAContext().Clone()
	ctx.RequestData.User.HasAnyPermissions = false

	// Mock no admin permissions
	mux := gqlclient.NewMux()
	acl.MockActorPermissions(mux, ctx.User, []acl.MockPermission{})
	ctx.GraphQLClient = gqlclient.NewMockClient(mux)

	// Build GraphQL client
	client := suite.BuildTestClientForSchema(
		ctx, graphql.NewExecutableSchema(graphql.Config{Resolvers: &Resolver{}}))

	mutation := `
		mutation Test_CreateUserAdaptiveAssessmentBatch_Unauthorized($userKaids: [String!]!) {
			createUserAdaptiveAssessmentBatch(userKaids: $userKaids) {
				enqueuedCount
				failedUserKaids
				error {
					message
					code
				}
			}
		}
	`

	// Execute mutation through GraphQL
	userKaids := []string{"kaid_test_1", "kaid_test_2"}
	resp, err := gqltest.Mutate(ctx, client.AsUser(), mutation, js.Obj{
		"userKaids": userKaids,
	})
	suite.Require().NoError(err)

	// Verify response has error with UNAUTHORIZED code
	expected := js.Obj{
		"createUserAdaptiveAssessmentBatch": js.Obj{
			"enqueuedCount":   0,
			"failedUserKaids": js.Array{},
			"error": js.Obj{
				"code":    "UNAUTHORIZED",
				"message": "Unauthorized",
			},
		},
	}
	suite.RequireJSONEqual(expected, resp)
}

func TestGapDetector(t *testing.T) {
	servicetest.Run(t, &gapDetectorSuite{})
}
