package coconut

import (
	"os"
	"strings"
	"sync"
)

var (
	keywords     []string
	keywordsOnce sync.Once
)

func loadKeywords() {
	env := os.Getenv("ALLERGEN_KEYWORDS")
	if env == "" {
		env = "coconut,cocos nucifera,copra"
	}
	for _, kw := range strings.Split(env, ",") {
		kw = strings.TrimSpace(strings.ToLower(kw))
		if kw != "" {
			keywords = append(keywords, kw)
		}
	}
}

// Detect returns true if the ingredients text contains any allergen keyword.
func Detect(ingredients string) bool {
	keywordsOnce.Do(loadKeywords)
	lower := strings.ToLower(ingredients)
	for _, kw := range keywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}
