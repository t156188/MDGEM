// Go 程序模板
package main

import (
	"fmt"
	"strings"
)

// Greeter 生成问候语。
type Greeter struct {
	Prefix string
}

func (g Greeter) Greet(names ...string) string {
	parts := make([]string, len(names))
	for i, n := range names {
		parts[i] = fmt.Sprintf("%s, %s!", g.Prefix, n)
	}
	return strings.Join(parts, "\n")
}

func main() {
	g := Greeter{Prefix: "Hello"}
	fmt.Println(g.Greet("MDGEM", "World"))
}
