#!/usr/bin/env bash
# Git add, commit, push, and optionally release @nmzpy/pi-ember-stack.
#
# Usage:
#   ./gacp.sh "commit message"
#   ./gacp.sh --release ["release commit message"]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_MODE=0
COMMIT_MSG=""

while (( $# > 0 )); do
	case "$1" in
		--release)
			RELEASE_MODE=1
			shift
			;;
		--message|-m)
			[[ -n "${2:-}" ]] || { echo "ERROR: --message requires a value." >&2; exit 1; }
			COMMIT_MSG="$2"
			shift 2
			;;
		--help|-h)
			cat <<'USAGE'
Usage:
  ./gacp.sh "commit message"
  ./gacp.sh --release ["release commit message"]

Release mode increments the npm patch version, typechecks, commits, tags, pushes,
and publishes @nmzpy/pi-ember-stack to npm.
USAGE
			exit 0
			;;
		-*)
			echo "ERROR: Unknown option: $1" >&2
			exit 1
			;;
		*)
			[[ -z "$COMMIT_MSG" ]] || { echo "ERROR: Unexpected argument: $1" >&2; exit 1; }
			COMMIT_MSG="$1"
			shift
			;;
	esac
done

cd "$SCRIPT_DIR"

if [[ "$RELEASE_MODE" == "1" ]]; then
	command -v npm >/dev/null || { echo "ERROR: npm is required for releases." >&2; exit 1; }
	npm whoami >/dev/null || {
		echo "ERROR: Log in to npm with 'npm login' before creating a release." >&2
		exit 1
	}

	VERSION="$(npm version patch --no-git-tag-version)"
	VERSION="${VERSION#v}"
	COMMIT_MSG="${COMMIT_MSG:-release: v$VERSION}"

	echo "=== Typechecking ==="
	npm run typecheck

	echo "=== Staging ==="
	git add package.json package-lock.json src README.md gacp.sh

	echo "=== Committing ==="
	git commit -m "$COMMIT_MSG"

	TAG_NAME="v$VERSION"
	if git rev-parse -q --verify "refs/tags/$TAG_NAME" >/dev/null; then
		echo "ERROR: Tag $TAG_NAME already exists." >&2
		exit 1
	fi
	git tag "$TAG_NAME"

	echo "=== Pushing ==="
	git push
	git push origin "$TAG_NAME"

	echo "=== Publishing @nmzpy/pi-ember-stack@$VERSION ==="
	npm publish --access public
	echo "=== Release $TAG_NAME complete ==="
	exit 0
fi

[[ -n "$COMMIT_MSG" ]] || { echo "ERROR: Commit message is required." >&2; exit 1; }
git add -A
git commit -m "$COMMIT_MSG"
git push
