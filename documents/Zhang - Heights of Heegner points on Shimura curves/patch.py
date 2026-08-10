import sys

import pikepdf

input_path = sys.argv[1] if len(sys.argv) > 1 else "cleaned.pdf"
output_path = sys.argv[2] if len(sys.argv) > 2 else "test.pdf"
pdf = pikepdf.open(input_path)

obj = pdf.objects[225]
assert obj.objgen == (236, 0)

commands = []
for operands, operator in pikepdf.parse_content_stream(obj):
        if operator == pikepdf.Operator('Tj'):
            if operands == pikepdf.Array([pikepdf.String(")")]):
                print(operands)
                continue
        # operands = pikepdf.Array([pikepdf.String("an")])
        commands.append([operands, operator])

new_content_stream = pikepdf.unparse_content_stream(commands)
obj.Contents = pdf.make_stream(new_content_stream)
pdf.objects[255] = obj

pdf.save(
    output_path,
    compress_streams=False,
    object_stream_mode=pikepdf.ObjectStreamMode.disable,
)
