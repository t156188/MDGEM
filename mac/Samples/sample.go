package main

import (
	"fmt"
	"strings"
)

func wordCount(input string) map[string]int {
	counts := map[string]int{}
	for _, word := range strings.Fields(strings.ToLower(input)) {
		counts[word]++
	}
	return counts
}

func main() {
	text := "Markdown preview preview code files"
	for word, count := range wordCount(text) {
		fmt.Printf("%s: %d\n", word, count)
	}
}
