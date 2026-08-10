import sys

import pikepdf

input_path = sys.argv[1] if len(sys.argv) > 1 else "cleaned.pdf"
output_path = sys.argv[2] if len(sys.argv) > 2 else "test.pdf"
pdf = pikepdf.open(input_path)

# Locate the stream by its stable context rather than relying on a pikepdf
# object-list index (cleaning may discard unreferenced objects).
markers = (
    (b"8.15029 0 Td\n(,)Tj\n5.87964 0 Td\n(and)Tj", "and"),
    # and_order.patch runs before this script in lexical order.
    (b"8.15029 0 Td\n(,)Tj\n5.87964 0 Td\n(an)Tj", "an"),
)
obj = None
raw_stream = b""
target_word = "and"
for candidate in pdf.objects:
    if not isinstance(candidate, pikepdf.Stream):
        continue
    candidate_data = candidate.read_bytes()
    for candidate_marker, candidate_word in markers:
        if candidate_marker in candidate_data:
            obj = candidate
            raw_stream = candidate_data
            target_word = candidate_word
            break
    if obj is not None:
        break
if obj is None:
    raise RuntimeError("could not locate the Darmon correction stream")

marker = next(marker for marker, word in markers if word == target_word)
marker_position = raw_stream.find(marker)
# There are other words with the same spelling in this content stream.  The
# occurrence after the marker is the one described by and_order.patch.
target_occurrence = raw_stream[:marker_position].count(
    f"({target_word})Tj".encode("ascii")
)
word_occurrence = 0

commands = []
for operands, operator in pikepdf.parse_content_stream(obj):
    if (
        operator == pikepdf.Operator("Tj")
        and len(operands) == 1
        and operands[0] == pikepdf.String(target_word)
    ):
        if word_occurrence == target_occurrence and target_word == "and":
            print(operands)
            operands = pikepdf.Array([pikepdf.String("an")])
        word_occurrence += 1
    commands.append([operands, operator])

new_content_stream = pikepdf.unparse_content_stream(commands)
obj.Contents = pdf.make_stream(new_content_stream)

pdf.save(output_path)
