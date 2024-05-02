import pikepdf

pdf = pikepdf.open('cleaned.pdf')

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

pdf.save("test.pdf")
