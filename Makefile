# BigScreen Dashboard — 常用开发命令
BINARY  ?= bigscreen-server
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all build test race vet fmt run dist clean

all: vet test build

build:
	@mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(BINARY) ./server
	@echo "built: bin/$(BINARY) ($(VERSION))"

test:
	go test -count=1 ./...

race:
	go test -race -count=1 ./...

vet:
	@out=$$(gofmt -l server); if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi
	go vet ./...

fmt:
	gofmt -w server/

run:
	go run ./server -port 8080 -data ./data

dist:
	VERSION=$(VERSION) scripts/build-all.sh

clean:
	rm -rf bin dist
