"""`python -m nagare`, equivalent to the `nagare` command.

Worth having as well as the console script: `-m` imports the package from the
checkout itself, so it still starts when the installed entry point cannot find
the package. That happens on macOS when the checkout sits in an iCloud-synced
folder: iCloud marks the venv's files hidden, and python 3.14 skips hidden .pth
files, which is where an editable install keeps its path.
"""

from .server import main

if __name__ == "__main__":
    main()
