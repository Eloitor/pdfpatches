import pikepdf

pdf = pikepdf.open('cleaned.pdf')

obj = pdf.objects[314]

commands = []
for operands, operator in pikepdf.parse_content_stream(obj):
        # print(f"Operands {operands}, operator {operator}")
        if operator == pikepdf.Operator('Tj'):
            if operands == pikepdf.Array([pikepdf.String("and")]):            
                print(operands)
        operands = pikepdf.Array([pikepdf.String("an")])
        commands.append([operands, operator])

new_content_stream = pikepdf.unparse_content_stream(commands)
obj.Contents = pdf.make_stream(new_content_stream)

pdf.save("test.pdf")
