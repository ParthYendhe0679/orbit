// Package config loads gateway settings from the environment and .env files.
package config

import (
	"bufio"
	"os"
	"strings"
	"time"
)

// LoadDotEnv reads KEY=VALUE lines from each file that exists and sets the
// variables that are not already present in the environment. Earlier files
// win over later ones, and the real environment wins over all of them, which
// matches python-dotenv's default (override=False) used by the ai-service.
func LoadDotEnv(paths ...string) []string {
	var loaded []string
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		loaded = append(loaded, p)
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			key, val, ok := parseLine(sc.Text())
			if !ok {
				continue
			}
			if _, exists := os.LookupEnv(key); !exists {
				_ = os.Setenv(key, val)
			}
		}
		_ = f.Close()
	}
	return loaded
}

func parseLine(line string) (string, string, bool) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return "", "", false
	}
	line = strings.TrimPrefix(line, "export ")
	key, val, ok := strings.Cut(line, "=")
	if !ok {
		return "", "", false
	}
	key = strings.TrimSpace(key)
	val = strings.TrimSpace(val)
	if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') && val[len(val)-1] == val[0] {
		val = val[1 : len(val)-1]
	} else if i := strings.Index(val, " #"); i >= 0 {
		val = strings.TrimSpace(val[:i])
	}
	return key, val, key != ""
}

// Env returns the first non-empty value among the given variable names.
func Env(names ...string) string {
	for _, n := range names {
		if v := strings.TrimSpace(os.Getenv(n)); v != "" {
			return v
		}
	}
	return ""
}

// EnvDefault returns the variable's value, or def when unset or blank.
func EnvDefault(name, def string) string {
	if v := Env(name); v != "" {
		return v
	}
	return def
}

// EnvDuration parses a Go duration (e.g. "12h"), falling back to def.
func EnvDuration(name string, def time.Duration) time.Duration {
	if v := Env(name); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}

// EnvList splits a comma-separated variable into trimmed, non-empty items.
func EnvList(name string) []string {
	var out []string
	for _, part := range strings.Split(os.Getenv(name), ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
