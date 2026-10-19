# `number-loom-bot` Privacy Policy
`number-loom-bot` reads images that are publicly uploaded and attempts to interpret them as puzzles. It stores some debugging information generated from the picture and its URL for 365 days. If requested (with the `!debug` or `!whynot` command), it may save an annotated copy of the image that may be accessed for debugging purposes.

If the original poster or a moderator uses the `!delete` command, all of the bot's comments in response to it will be taken down, and the bot delete everything but a record indicating that it was deleted. Every link to the annotated copy of the image will be gone (at time of writing, it's not possible to delete bot-uploaded media).

The bot also stores a list of IDs of users who have used `!optout` so it knows to not respond to them.