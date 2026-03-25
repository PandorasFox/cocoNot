package coconut

import (
	"strings"
)

// Keywords that indicate coconut presence in an ingredients list.
var coconutKeywords = []string{
	"coconut",
	"cocos nucifera",
	"copra",
}

// Detect returns true if the ingredients text contains any coconut indicator.
func Detect(ingredients string) bool {
	lower := strings.ToLower(ingredients)
	for _, kw := range coconutKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}
