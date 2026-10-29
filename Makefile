.PHONY: run test check

run:
	python3 server.py

test:
	python3 -m unittest discover -s tests -v

check:
	python3 -c "import ast, pathlib; [ast.parse(p.read_text()) for p in [pathlib.Path('server.py'), *pathlib.Path('tests').glob('*.py')]]"
	node --check public/app.js
