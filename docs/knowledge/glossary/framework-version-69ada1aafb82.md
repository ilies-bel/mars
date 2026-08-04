# Framework version

A semver git tag (vMAJOR.MINOR.PATCH) on the mars-framework repository; the canonical identifier of a framework release and the source of truth consulted by 'mars update'. The version lives only as a git tag — there is no package.json version field and no VERSION file. The tag is autobumped on every release-worthy push to main, so 'mars update' always finds a fresh tag to pull.
