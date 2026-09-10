package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type AIServiceStatus struct {
	Status string `json:"status"`
}

type HealthResponse struct {
	Status    string          `json:"status"`
	Service   string          `json:"service"`
	AIService AIServiceStatus `json:"ai_service"`
	Timestamp string          `json:"timestamp"`
}

// HealthHandler returns an http.HandlerFunc that checks the health of the Go gateway
// and probes the AI service with a 2-second timeout.
func HealthHandler(aiServiceURL string) http.HandlerFunc {
	// Trim trailing slash for reliable path concatenation
	baseURL := strings.TrimRight(aiServiceURL, "/")
	client := &http.Client{
		Timeout: 2 * time.Second,
	}

	return func(w http.ResponseWriter, r *http.Request) {
		aiStatus := "unavailable"

		// Probe Python AI service /health endpoint
		resp, err := client.Get(baseURL + "/health")
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				aiStatus = "ok"
			}
		}

		overallStatus := "ok"
		if aiStatus != "ok" {
			overallStatus = "degraded"
		}

		health := HealthResponse{
			Status:  overallStatus,
			Service: "go-backend",
			AIService: AIServiceStatus{
				Status: aiStatus,
			},
			Timestamp: time.Now().UTC().Format(time.RFC3339),
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(health)
	}
}
