.PHONY: run test check test-browser

run:
	python3 server.py

test:
	python3 -m unittest discover -s tests -v
	node --test --test-isolation=none tests/*.test.mjs

test-browser:
	npm run test:browser

check:
	python3 -c "import ast, pathlib; [ast.parse(p.read_text()) for p in [pathlib.Path('server.py'), *pathlib.Path('tests').glob('*.py')]]"
	node --check public/app.js
	node --check public/playback.js
	node --check playwright.config.js
	node --check e2e/teleprompter.spec.js
