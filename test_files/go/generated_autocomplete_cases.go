package main

import "strings"

func formatStatus(name string, active bool) string {
	if active {
		return name + ":active"
	}
	return name + ":inactive"
}

func caseCallCompletion(user string) string {
	status := formatStatus(
	return status
}

func caseSuffixOnly(value string) string {
	return strings.ToLow
}
