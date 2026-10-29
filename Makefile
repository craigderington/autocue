.PHONY: run test check test-browser test-browser-docker

run:
	python3 server.py

test:
	python3 -m unittest discover -s tests -v
	node --test --test-isolation=none tests/*.test.mjs

test-browser:
	npm run test:browser

test-browser-docker:
	docker build --file Dockerfile.browser-tests --tag omarchy-teleprompter-browser-tests:local .
	mkdir -p playwright-report test-results
	docker run --rm --init --shm-size=1g \
		--mount "type=bind,src=$(CURDIR)/playwright-report,dst=/app/playwright-report" \
		--mount "type=bind,src=$(CURDIR)/test-results,dst=/app/test-results" \
		omarchy-teleprompter-browser-tests:local

check:
	python3 -c "import ast, pathlib; [ast.parse(p.read_text()) for p in [pathlib.Path('server.py'), *pathlib.Path('tests').glob('*.py')]]"
	node --check public/app.js
	node --check public/playback.js
	node --check playwright.config.js
	node --check e2e/teleprompter.spec.js
